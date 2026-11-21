// Package api 提供打印助手的 HTTP 接口与静态前端服务。
package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"printbox/internal/discover"
	"image/jpeg"
	"image/png"
	"printbox/internal/files"
	"printbox/internal/ipp"
	"printbox/internal/pdfconv"
	"printbox/internal/raw"
	"printbox/internal/store"
)

// Config 是应用运行配置。
type Config struct {
	DataDir     string
	SharedDir   string
	UploadDir   string
	WebDir      string
	Version     string
	PdftoppmPath string
	LibDir       string
	TmpDir       string
}

// Server 是 HTTP 服务器。
type Server struct {
	cfg  Config
	st   *store.Store
	fm   *files.Manager
	mux  *http.ServeMux
	conv pdfconv.Converter
}

// New 创建服务器并注册路由。
func New(cfg Config, st *store.Store) *Server {
	if cfg.UploadDir == "" {
		cfg.UploadDir = filepath.Join(cfg.DataDir, "uploads")
	}
	_ = os.MkdirAll(cfg.UploadDir, 0o755)
	roots := []string{}
	if cfg.SharedDir != "" {
		if abs, err := filepath.Abs(cfg.SharedDir); err == nil {
			roots = append(roots, abs)
		}
	}
	if abs, err := filepath.Abs(cfg.DataDir); err == nil {
		roots = append(roots, abs)
	}
	s := &Server{cfg: cfg, st: st, fm: files.New(roots, cfg.UploadDir), mux: http.NewServeMux()}
	s.conv = pdfconv.Converter{Pdftoppm: cfg.PdftoppmPath, LibDir: cfg.LibDir, TmpDir: cfg.TmpDir}
	s.routes()
	return s
}

// Handler 返回根路由。
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /api/health", s.handleHealth)
	m.HandleFunc("GET /api/meta", s.handleMeta)
	m.HandleFunc("GET /api/settings", s.handleGetSettings)
	m.HandleFunc("PUT /api/settings", s.handlePutSettings)

	m.HandleFunc("GET /api/printers", s.handleListPrinters)
	m.HandleFunc("POST /api/printers", s.handleSavePrinter)
	m.HandleFunc("POST /api/printers/default", s.handleDefaultPrinter)
	m.HandleFunc("DELETE /api/printers/{id}", s.handleDeletePrinter)
	m.HandleFunc("GET /api/printers/discover", s.handleDiscover)
	m.HandleFunc("GET /api/scanners/discover", s.handleDiscoverScanners)
	m.HandleFunc("GET /api/scanners/status", s.handleScannerStatus)
	m.HandleFunc("POST /api/scanners/scan", s.handleScan)
	m.HandleFunc("GET /api/printers/status", s.handleStatus)

	m.HandleFunc("POST /api/print", s.handlePrint)
	m.HandleFunc("POST /api/print/test", s.handleTestPage)
	m.HandleFunc("GET /api/jobs", s.handleListJobs)
	m.HandleFunc("POST /api/jobs/{id}/cancel", s.handleCancelJob)
	m.HandleFunc("POST /api/jobs/{id}/retry", s.handleRetryJob)

	m.HandleFunc("GET /api/files/roots", s.handleFileRoots)
	m.HandleFunc("GET /api/files/list", s.handleFileList)
	m.HandleFunc("GET /api/files/search", s.handleFileSearch)
	m.HandleFunc("GET /api/files/content", s.handleFileContent)
	m.HandleFunc("POST /api/files/upload", s.handleUpload)
	m.HandleFunc("POST /api/files/fetch-url", s.handleFetchURL)

	m.HandleFunc("GET /api/favorites", s.handleListFavorites)
	m.HandleFunc("POST /api/favorites", s.handleAddFavorite)
	m.HandleFunc("DELETE /api/favorites", s.handleRemoveFavorite)
	m.HandleFunc("GET /api/recents", s.handleRecents)
	m.HandleFunc("POST /api/recents", s.handleTouchRecent)

	// 静态前端
	fs := http.FileServer(http.Dir(s.cfg.WebDir))
	m.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, filepath.Join(s.cfg.WebDir, "index.html"))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	}))
}

// StartWorker 启动打印队列工作线程。
func (s *Server) StartWorker() {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("打印队列异常退出：%v", r)
			}
		}()
		for {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("处理任务异常：%v", r)
					}
				}()
				job, err := s.st.NextQueuedJob()
				if err != nil {
					if err != sql.ErrNoRows {
						log.Printf("队列查询失败：%v", err)
					}
					return
				}
				s.processJob(job)
			}()
			time.Sleep(1200 * time.Millisecond)
		}
	}()
}

func (s *Server) processJob(job *store.Job) {
	if job.Status != "queued" {
		return
	}
	_ = s.st.UpdateJobStatus(job.ID, "processing", "")
	if cur, err := s.st.GetJob(job.ID); err == nil && cur.Status == "canceled" {
		return
	}

	printerIP := job.PrinterIP
	if printerIP == "" {
		if p, err := s.defaultPrinter(); err == nil {
			printerIP = p.IP
		}
	}
	if printerIP == "" {
		_ = s.st.UpdateJobStatus(job.ID, "failed", "未选择打印机")
		return
	}

	var data []byte
	var format string
	var sourcePath string
	fileName := job.FileName
	if job.FilePath == "__test_page__" {
		data = buildTestImage(s.cfg.Version)
		format = "image/jpeg"
		fileName = "test-page.jpg"
	} else {
		b, err := os.ReadFile(job.FilePath)
		if err != nil {
			_ = s.st.UpdateJobStatus(job.ID, "failed", "读取文件失败："+err.Error())
			return
		}
		data = b
		sourcePath = job.FilePath
		format = mimeOf(job.FilePath)
		if format == "" {
			_ = s.st.UpdateJobStatus(job.ID, "failed", "不支持的文件类型（仅支持 PDF 与图片）")
			return
		}
	}

	opt := ipp.Options{Copies: job.Copies, Paper: job.Paper, Duplex: job.Duplex, Color: job.Color, Scale: job.Scale}
	if err := s.doPrint(printerIP, fileName, data, format, sourcePath, job.Pages, opt); err != nil {
		_ = s.st.UpdateJobStatus(job.ID, "failed", err.Error())
		log.Printf("打印失败 %s：%v", job.ID, err)
		return
	}
	_ = s.st.UpdateJobStatus(job.ID, "done", "")
	log.Printf("打印完成 %s（%s）", job.ID, fileName)
}

// doPrint 按打印机支持的格式发送任务；PDF 不被支持时渲染为 JPEG 逐页打印。
// parsePageRange 解析 "1-3,5" 形式的页码范围；pageRange 为空表示全部。
func parsePageRange(pageRange string, total int) ([]int, error) {
	pageRange = strings.TrimSpace(pageRange)
	if pageRange == "" {
		return nil, nil
	}
	var pages []int
	seen := map[int]bool{}
	for _, part := range strings.Split(pageRange, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "-") {
			segs := strings.SplitN(part, "-", 2)
			a, err1 := strconv.Atoi(strings.TrimSpace(segs[0]))
			b, err2 := strconv.Atoi(strings.TrimSpace(segs[1]))
			if err1 != nil || err2 != nil || a <= 0 || b < a {
				return nil, fmt.Errorf("页码范围无效")
			}
			if total > 0 && a > total {
				return nil, fmt.Errorf("页码超出范围（共 %d 页）", total)
			}
			if total > 0 && b > total {
				b = total
			}
			for i := a; i <= b; i++ {
				if !seen[i] {
					pages = append(pages, i)
					seen[i] = true
				}
			}
		} else {
			n, err := strconv.Atoi(part)
			if err != nil || n <= 0 {
				return nil, fmt.Errorf("页码无效")
			}
			if total > 0 && n > total {
				return nil, fmt.Errorf("页码超出范围（共 %d 页）", total)
			}
			if !seen[n] {
				pages = append(pages, n)
				seen[n] = true
			}
		}
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("页码范围为空")
	}
	return pages, nil
}

func (s *Server) doPrint(ip, fileName string, data []byte, format, sourcePath, pageRange string, opt ipp.Options) error {
	client := ipp.New(ip)
	cap, err := client.GetCapability()
	if err == nil && cap.URI != "" {
		client.URI = cap.URI
	}
	if s.protocolOf(ip) == "raw" {
		return raw.Print(ip, data)
	}
	supportsPDF := err != nil || cap.Supports("application/pdf")
	supportsJPEG := err != nil || cap.Supports("image/jpeg")

	if format == "application/pdf" {
		if supportsPDF {
			return client.Print(fileName, data, "application/pdf", opt)
		}
		if supportsJPEG && s.conv.Available() && sourcePath != "" {
			rendered, perr := s.conv.ToJPEG(sourcePath, 150)
			if perr != nil {
				return perr
			}
			defer pdfconv.Cleanup(rendered)
			selected, rerr := parsePageRange(pageRange, len(rendered))
			if rerr != nil {
				return rerr
			}
			if selected == nil {
				for i := 1; i <= len(rendered); i++ {
					selected = append(selected, i)
				}
			}
			for _, p := range selected {
				if p < 1 || p > len(rendered) {
					continue
				}
				b, err := os.ReadFile(rendered[p-1])
				if err != nil {
					return fmt.Errorf("读取渲染页失败：%w", err)
				}
				if err := client.Print(fmt.Sprintf("%s p%d", fileName, p), b, "image/jpeg", opt); err != nil {
					return fmt.Errorf("第 %d 页打印失败：%w", p, err)
				}
			}
			return nil
		}
		return fmt.Errorf("打印机不支持 PDF 直打，且 PDF 渲染组件不可用（%s）；请确认使用 amd64 安装包，或先转为图片打印", s.cfg.PdftoppmPath)
	}

	if format == "image/jpeg" {
		if supportsJPEG {
			return client.Print(fileName, data, "image/jpeg", opt)
		}
		return raw.Print(ip, data)
	}
	if format == "image/png" {
		jpg, jerr := pngToJPEG(data)
		if jerr != nil {
			return jerr
		}
		if supportsJPEG {
			return client.Print(fileName, jpg, "image/jpeg", opt)
		}
		return raw.Print(ip, data)
	}
	return fmt.Errorf("不支持的文档格式：%s", format)
}

// pngToJPEG 把 PNG 转码为 JPEG（打印机普遍支持 JPEG）。
func pngToJPEG(data []byte) ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("PNG 解码失败")
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		return nil, fmt.Errorf("JPEG 编码失败")
	}
	return buf.Bytes(), nil
}

func (s *Server) protocolOf(ip string) string {
	ps, _ := s.st.ListPrinters()
	for _, p := range ps {
		if p.IP == ip && p.Protocol != "" {
			return p.Protocol
		}
	}
	// 探测：能取状态则 IPP
	c := ipp.New(ip)
	if _, err := c.GetStatus(); err == nil {
		return "ipp"
	}
	return "raw"
}

func (s *Server) defaultPrinter() (store.Printer, error) {
	ps, err := s.st.ListPrinters()
	if err != nil {
		return store.Printer{}, err
	}
	for _, p := range ps {
		if p.IsDefault {
			return p, nil
		}
	}
	if len(ps) > 0 {
		return ps[0], nil
	}
	return store.Printer{}, fmt.Errorf("尚未添加打印机")
}

func mimeOf(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pdf":
		return "application/pdf"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	default:
		return ""
	}
}

// ---------- 基础 ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "version": s.cfg.Version, "time": time.Now().Format(time.RFC3339)})
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	settings, _ := s.st.AllSettings()
	printer, _ := s.defaultPrinter()
	sharedEntries := []string{}
	if s.cfg.SharedDir != "" {
		if entries, err := os.ReadDir(s.cfg.SharedDir); err == nil {
			for _, e := range entries {
				sharedEntries = append(sharedEntries, e.Name())
			}
		}
	}
	writeJSON(w, 200, map[string]any{
		"version":        s.cfg.Version,
		"roots":          s.fm.Roots,
		"shared_dir":     s.cfg.SharedDir,
		"shared_entries": sharedEntries,
		"shared_ready":   len(sharedEntries) > 0,
		"data_dir":       s.cfg.DataDir,
		"upload_dir":     s.cfg.UploadDir,
		"settings":       settings,
		"printer":        printer,
	})
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	all, _ := s.st.AllSettings()
	writeJSON(w, 200, all)
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := readJSON(r, &body); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	for k, v := range body {
		if err := s.st.SetSetting(k, v); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
	}
	all, _ := s.st.AllSettings()
	writeJSON(w, 200, all)
}

// ---------- 打印机 ----------

func (s *Server) handleListPrinters(w http.ResponseWriter, r *http.Request) {
	ps, err := s.st.ListPrinters()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if ps == nil {
		ps = []store.Printer{}
	}
	writeJSON(w, 200, ps)
}

func (s *Server) handleSavePrinter(w http.ResponseWriter, r *http.Request) {
	var p store.Printer
	if err := readJSON(r, &p); err != nil || p.IP == "" {
		writeErr(w, 400, "缺少打印机地址")
		return
	}
	if p.Protocol == "" {
		p.Protocol = "ipp"
	}
	if p.Name == "" {
		p.Name = p.IP
	}
	if err := s.st.SavePrinter(&p); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, p)
}

func (s *Server) handleDefaultPrinter(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil || body.ID == "" {
		writeErr(w, 400, "缺少 id")
		return
	}
	if err := s.st.SetDefaultPrinter(body.ID); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleDeletePrinter(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeletePrinter(r.PathValue("id")); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleDiscover(w http.ResponseWriter, r *http.Request) {
	hosts := discover.LocalHosts()
	found := discover.Scan(hosts)
	if found == nil {
		found = []discover.Found{}
	}
	writeJSON(w, 200, map[string]any{"printers": found, "scanned": len(hosts)})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	ip := r.URL.Query().Get("ip")
	if ip == "" {
		p, err := s.defaultPrinter()
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		ip = p.IP
	}
	st, err := ipp.New(ip).GetStatus()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ip": ip, "state": "offline", "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ip": ip, "state": st.State, "reasons": st.Reasons, "name": st.Name, "model": st.Model})
}

// ---------- 打印 ----------

type printReq struct {
	FilePath    string `json:"file_path"`
	PrinterIP   string `json:"printer_ip"`
	PrinterName string `json:"printer_name"`
	Copies      int    `json:"copies"`
	Paper       string `json:"paper"`
	Duplex      bool   `json:"duplex"`
	Color       bool   `json:"color"`
	Scale       string `json:"scale"`
	Pages       string `json:"pages"`
	SaveAsDefault bool `json:"save_as_default"`
}

func (s *Server) handlePrint(w http.ResponseWriter, r *http.Request) {
	var req printReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if strings.TrimSpace(req.FilePath) == "" {
		writeErr(w, 400, "缺少文件路径")
		return
	}
	if _, err := os.Stat(req.FilePath); err != nil {
		writeErr(w, 404, "文件不存在")
		return
	}
	if f := mimeOf(req.FilePath); f == "" {
		writeErr(w, 400, "暂不支持该文件类型，请先转换为 PDF")
		return
	}
	if req.PrinterIP == "" {
		p, err := s.defaultPrinter()
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		req.PrinterIP = p.IP
		req.PrinterName = p.Name
	}
	job := &store.Job{
		FilePath:   req.FilePath,
		FileName:   filepath.Base(req.FilePath),
		PrinterIP: req.PrinterIP,
		PrinterName: req.PrinterName,
		Copies:    req.Copies,
		Paper:     req.Paper,
		Duplex:    req.Duplex,
		Color:     req.Color,
		Scale:     req.Scale,
		Pages:     strings.TrimSpace(req.Pages),
		Status:    "queued",
	}
	if job.Pages != "" {
		if _, perr := parsePageRange(job.Pages, 0); perr != nil {
			writeErr(w, 400, "页码范围格式不正确，例如 1-3,5")
			return
		}
	}
	if err := s.st.CreateJob(job); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	_ = s.st.TouchRecent(req.FilePath, job.FileName)
	if req.SaveAsDefault {
		_ = s.st.SetSetting("default_copies", fmt.Sprintf("%d", req.Copies))
		_ = s.st.SetSetting("default_paper", req.Paper)
		_ = s.st.SetSetting("default_duplex", boolStr(req.Duplex))
		_ = s.st.SetSetting("default_color", boolStr(req.Color))
		_ = s.st.SetSetting("default_scale", req.Scale)
	}
	writeJSON(w, 200, job)
}

func (s *Server) handleTestPage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PrinterIP string `json:"printer_ip"`
	}
	_ = readJSON(r, &req)
	ip := req.PrinterIP
	name := ""
	if ip == "" {
		p, err := s.defaultPrinter()
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		ip = p.IP
		name = p.Name
	}
	job := &store.Job{
		FilePath: "__test_page__", FileName: "test-page.pdf", PrinterIP: ip, PrinterName: name,
		Copies: 1, Paper: "A4", Scale: "fit", Status: "queued",
	}
	if job.Pages != "" {
		if _, perr := parsePageRange(job.Pages, 0); perr != nil {
			writeErr(w, 400, "页码范围格式不正确，例如 1-3,5")
			return
		}
	}
	if err := s.st.CreateJob(job); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, job)
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.st.ListJobs(200)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if jobs == nil {
		jobs = []store.Job{}
	}
	writeJSON(w, 200, jobs)
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	if err := s.st.CancelJob(r.PathValue("id")); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRetryJob(w http.ResponseWriter, r *http.Request) {
	if err := s.st.RetryJob(r.PathValue("id")); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- 文件 ----------

func (s *Server) handleFileRoots(w http.ResponseWriter, r *http.Request) {
	type root struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	var out []root
	if s.cfg.SharedDir != "" {
		if abs, err := filepath.Abs(s.cfg.SharedDir); err == nil {
			if st, err := os.Stat(abs); err == nil && st.IsDir() {
				out = append(out, root{Name: "共享文件", Path: abs})
			}
		}
	}
	if st, err := os.Stat(s.cfg.UploadDir); err == nil && st.IsDir() {
		out = append(out, root{Name: "上传文件", Path: s.cfg.UploadDir})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, 400, "缺少 path")
		return
	}
	entries, err := s.fm.List(path)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	abs, _ := filepath.Abs(path)
	writeJSON(w, 200, map[string]any{"path": abs, "parent": filepath.Dir(abs), "entries": entries})
}

func (s *Server) handleFileSearch(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("root")
	if root == "" {
		root = s.cfg.DataDir
	}
	entries, err := s.fm.Search(root, r.URL.Query().Get("q"), r.URL.Query().Get("kind"), 200)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if entries == nil {
		entries = []files.Entry{}
	}
	writeJSON(w, 200, entries)
}

func (s *Server) handleFileContent(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, 400, "缺少 path")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, 404, "文件不存在")
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", mimeOf(path))
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, 400, "解析上传失败")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "缺少文件")
		return
	}
	defer file.Close()
	saved, err := s.fm.SaveUpload(header.Filename, file)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"path": saved, "name": filepath.Base(saved)})
}

func (s *Server) handleFetchURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := readJSON(r, &body); err != nil || body.URL == "" {
		writeErr(w, 400, "缺少 url")
		return
	}
	saved, err := s.fm.FetchURL(body.URL)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"path": saved, "name": filepath.Base(saved)})
}

// ---------- 收藏与最近 ----------

func (s *Server) handleListFavorites(w http.ResponseWriter, r *http.Request) {
	items, _ := s.st.ListFavorites()
	if items == nil {
		items = []map[string]string{}
	}
	writeJSON(w, 200, items)
}

func (s *Server) handleAddFavorite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := readJSON(r, &body); err != nil || body.Path == "" {
		writeErr(w, 400, "缺少 path")
		return
	}
	if body.Name == "" {
		body.Name = filepath.Base(body.Path)
	}
	if err := s.st.AddFavorite(body.Path, body.Name); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRemoveFavorite(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, 400, "缺少 path")
		return
	}
	_ = s.st.RemoveFavorite(path)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRecents(w http.ResponseWriter, r *http.Request) {
	items, _ := s.st.ListRecents(20)
	if items == nil {
		items = []map[string]string{}
	}
	writeJSON(w, 200, items)
}

func (s *Server) handleTouchRecent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := readJSON(r, &body); err != nil || body.Path == "" {
		writeErr(w, 400, "缺少 path")
		return
	}
	if body.Name == "" {
		body.Name = filepath.Base(body.Path)
	}
	_ = s.st.TouchRecent(body.Path, body.Name)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
