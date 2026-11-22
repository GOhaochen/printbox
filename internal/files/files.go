// Package files 提供文件浏览、搜索、上传与下载能力。
package files

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Entry 是文件或目录条目。
type Entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
	Kind    string `json:"kind"` // pdf / image / office / other / dir
}

// Manager 管理可浏览的根目录。
type Manager struct {
	Roots     []string
	UploadDir string
	TempDir   string
}

// New 创建管理器。
func New(roots []string, uploadDir string) *Manager {
	return &Manager{Roots: roots, UploadDir: uploadDir}
}

func kindOf(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "pdf"
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp":
		return "image"
	case ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".ods", ".odt":
		return "office"
	default:
		return "other"
	}
}

// List 列出目录内容（目录在前）。
func (m *Manager) List(path string) ([]Entry, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败：%w", err)
	}
	var out []Entry
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || strings.Contains(e.Name(), ".db-shm") || strings.Contains(e.Name(), ".db-wal") || strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		full := filepath.Join(abs, e.Name())
		info, ierr := os.Stat(full)
		if ierr != nil {
			continue
		}
		kind := "dir"
		if !info.IsDir() {
			kind = kindOf(e.Name())
		}
		out = append(out, Entry{
			Name:    e.Name(),
			Path:    full,
			IsDir:   info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Format(time.RFC3339),
			Kind:    kind,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Search 在根目录下递归搜索文件名，可按类型过滤。
func (m *Manager) Search(root, keyword, kind string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var out []Entry
	count := 0
	kw := strings.ToLower(keyword)
	_ = filepath.Walk(abs, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		if info.IsDir() {
			if strings.HasPrefix(info.Name(), ".") && path != abs {
				return filepath.SkipDir
			}
			return nil
		}
		count++
		if count > 20000 {
			return io.EOF
		}
		if kw != "" && !strings.Contains(strings.ToLower(info.Name()), kw) {
			return nil
		}
		k := kindOf(info.Name())
		if kind != "" && kind != "all" && k != kind {
			return nil
		}
		out = append(out, Entry{
			Name:    info.Name(),
			Path:    path,
			Size:    info.Size(),
			ModTime: info.ModTime().Format(time.RFC3339),
			Kind:    k,
		})
		if len(out) >= limit {
			return io.EOF
		}
		return nil
	})
	return out, nil
}

// SaveUpload 保存上传的文件到上传目录。
func (m *Manager) SaveUpload(name string, r io.Reader) (string, error) {
	dir := filepath.Join(m.UploadDir, time.Now().Format("2006-01"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	safe := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if safe == "" || safe == "." {
		safe = fmt.Sprintf("upload-%d", time.Now().UnixNano())
	}
	path := filepath.Join(dir, safe)
	// 同名文件加时间后缀
	if _, err := os.Stat(path); err == nil {
		ext := filepath.Ext(safe)
		base := strings.TrimSuffix(safe, ext)
		path = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, time.Now().Unix(), ext))
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return "", err
	}
	return path, nil
}

// SaveTemp 保存到临时打印目录（打印后可自动删除）。
func (m *Manager) SaveTemp(name string, r io.Reader) (string, error) {
	dir := m.TempDir
	if dir == "" {
		dir = m.UploadDir
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	safe := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if safe == "" || safe == "." {
		safe = fmt.Sprintf("temp-%d", time.Now().UnixNano())
	}
	path := filepath.Join(dir, safe)
	if _, err := os.Stat(path); err == nil {
		ext := filepath.Ext(safe)
		base := strings.TrimSuffix(safe, ext)
		path = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, time.Now().UnixNano(), ext))
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return "", err
	}
	return path, nil
}

// FetchURL 下载网络文件并保存到上传目录（限制 100MB）。
func (m *Manager) FetchURL(url string) (string, error) {
	return m.FetchURLTo(url, m.UploadDir)
}

// FetchURLTo 下载网络文件到指定目录（限制 100MB）。
func (m *Manager) FetchURLTo(url, targetDir string) (string, error) {
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "", fmt.Errorf("仅支持 http/https 链接")
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("下载失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}
	name := filepath.Base(resp.Request.URL.Path)
	if name == "" || name == "/" || name == "." {
		name = fmt.Sprintf("download-%d", time.Now().UnixNano())
	}
	base := targetDir
	if base == "" {
		base = m.UploadDir
	}
	dir := filepath.Join(base, time.Now().Format("2006-01"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err == nil {
		ext := filepath.Ext(name)
		base := strings.TrimSuffix(name, ext)
		path = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, time.Now().Unix(), ext))
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.CopyN(f, resp.Body, 100<<20); err != nil && err != io.EOF {
		return "", err
	}
	return path, nil
}
