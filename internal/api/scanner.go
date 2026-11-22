package api

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"printbox/internal/escl"
	"printbox/internal/store"
)

// scannerFound 是发现到的扫描仪。
type scannerFound struct {
	IP          string `json:"ip"`
	Model       string `json:"model"`
	URL         string `json:"url"`
	FromPrinter bool   `json:"from_printer"`
}

// handleDiscoverScanners 探测局域网中支持 eSCL 的扫描仪。
func (s *Server) handleDiscoverScanners(w http.ResponseWriter, r *http.Request) {
	var mu sync.Mutex
	var found []scannerFound
	seen := map[string]bool{}

	// 优先检查已添加的打印机是否支持扫描（多数一体机同时具备扫描功能）
	if ps, err := s.st.ListPrinters(); err == nil {
		var wg sync.WaitGroup
		for _, p := range ps {
			if p.IP == "" || seen[p.IP] {
				continue
			}
			seen[p.IP] = true
			wg.Add(1)
			go func(ip string) {
				defer wg.Done()
				if model, ok := probeScanner(ip); ok {
					mu.Lock()
					found = append(found, scannerFound{IP: ip, Model: model + "（打印机内置扫描）", URL: "http://" + ip, FromPrinter: true})
					mu.Unlock()
				}
			}(p.IP)
		}
		wg.Wait()
	}

	hosts := localHosts()
	var wg sync.WaitGroup
	sem := make(chan struct{}, 48)
	for _, ip := range hosts {
		if seen[ip] {
			continue
		}
		seen[ip] = true
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if model, ok := probeScanner(ip); ok {
				mu.Lock()
				found = append(found, scannerFound{IP: ip, Model: model, URL: "http://" + ip})
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	if found == nil {
		found = []scannerFound{}
	}
	writeJSON(w, 200, map[string]any{"scanners": found, "scanned": len(hosts)})
}

// probeScanner 探测某个地址是否为 eSCL 扫描仪。
func probeScanner(ip string) (string, bool) {
	c := escl.New("http://" + ip)
	c.HTTP.Timeout = 900 * time.Millisecond
	if _, err := c.GetCapabilities(); err != nil {
		return "", false
	}
	return "eSCL 扫描仪", true
}

// handleListScanners 返回已保存的扫描仪。
func (s *Server) handleListScanners(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListScanners()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if list == nil {
		list = []store.Printer{}
	}
	writeJSON(w, 200, list)
}

// handleSaveScanner 保存扫描仪。
func (s *Server) handleSaveScanner(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IP    string `json:"ip"`
		Name  string `json:"name"`
		Model string `json:"model"`
	}
	if err := readJSON(r, &body); err != nil || body.IP == "" {
		writeErr(w, 400, "缺少扫描仪地址")
		return
	}
	if body.Name == "" {
		body.Name = body.IP
	}
	if err := s.st.SaveScanner(body.IP, body.Name, body.Model); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleDeleteScanner 删除扫描仪。
func (s *Server) handleDeleteScanner(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteScanner(r.PathValue("id")); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleDefaultScanner 设置默认扫描仪。
func (s *Server) handleDefaultScanner(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil || body.ID == "" {
		writeErr(w, 400, "缺少 id")
		return
	}
	if err := s.st.SetDefaultScanner(body.ID); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleScannerStatus 查询扫描仪状态。
func (s *Server) handleScannerStatus(w http.ResponseWriter, r *http.Request) {
	ip := r.URL.Query().Get("ip")
	if ip == "" {
		writeErr(w, 400, "缺少 ip")
		return
	}
	c := escl.New("http://" + ip)
	c.HTTP.Timeout = 6 * time.Second
	st, err := c.GetStatus()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ip": ip, "state": "offline", "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ip": ip, "state": st.State})
}

// handleScan 执行一次扫描并保存为图片文件。
func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IP       string `json:"ip"`
		DPI      int    `json:"dpi"`
		ColorMode string `json:"color_mode"`
		Format   string `json:"format"`
	}
	if err := readJSON(r, &body); err != nil || body.IP == "" {
		writeErr(w, 400, "缺少扫描仪地址")
		return
	}
	opt := escl.DefaultScanOptions()
	if body.DPI > 0 {
		opt.DPI = body.DPI
	}
	if body.ColorMode != "" {
		opt.ColorMode = body.ColorMode
	}
	if body.Format != "" {
		opt.Format = body.Format
	}
	client := escl.New("http://" + body.IP)
	client.HTTP.Timeout = 180 * time.Second
	data, contentType, err := client.Scan(opt)
	if err != nil {
		writeErr(w, 500, "扫描失败："+err.Error())
		return
	}
	if len(data) == 0 {
		writeErr(w, 500, "扫描返回空数据")
		return
	}
	ext := ".jpg"
	if contentType == "image/png" {
		ext = ".png"
	}
	name := "scan-" + time.Now().Format("20060102-150405") + ext
	path, err := s.fm.SaveUpload(name, bytes.NewReader(data))
	if err != nil {
		writeErr(w, 500, "保存扫描结果失败："+err.Error())
		return
	}
	_ = s.st.TouchRecent(path, filepath.Base(path))
	writeJSON(w, 200, map[string]any{
		"path": path,
		"name": filepath.Base(path),
		"size": len(data),
		"dpi":  opt.DPI,
		"mode": opt.ColorMode,
	})
}

// localHosts 返回本机 /24 网段主机地址。
func localHosts() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var hosts []string
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.To4() == nil {
			continue
		}
		ip := ipnet.IP.To4()
		if ip.IsLoopback() {
			continue
		}
		base := fmt.Sprintf("%d.%d.%d.", ip[0], ip[1], ip[2])
		if seen[base] {
			continue
		}
		seen[base] = true
		for i := 1; i < 255; i++ {
			hosts = append(hosts, fmt.Sprintf("%s%d", base, i))
		}
	}
	return hosts
}
