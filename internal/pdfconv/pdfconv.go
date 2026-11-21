// Package pdfconv 把 PDF 渲染为 JPEG（借助 poppler 的 pdftoppm）。
package pdfconv

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Converter 负责 PDF 转图片。
type Converter struct {
	Pdftoppm string // pdftoppm 可执行文件路径
	LibDir   string // 附带的动态库目录（可为空）
	TmpDir   string // 临时目录（应用数据目录下，避免系统 /tmp 不可用）
}

// Available 判断转换器是否可用。
func (c Converter) Available() bool {
	if c.Pdftoppm == "" {
		return false
	}
	_, err := os.Stat(c.Pdftoppm)
	return err == nil
}

// ToJPEG 将 PDF 每页渲染为 JPEG，返回按页序排列的文件路径。
func (c Converter) ToJPEG(pdfPath string, dpi int) ([]string, error) {
	if !c.Available() {
		return nil, fmt.Errorf("未找到 PDF 渲染组件（pdftoppm）")
	}
	if dpi <= 0 {
		dpi = 150
	}
	base := c.TmpDir
	if base == "" {
		base = os.TempDir()
	}
	_ = os.MkdirAll(base, 0o755)
	dir, err := os.MkdirTemp(base, "printbox-pdf-")
	if err != nil {
		return nil, err
	}
	prefix := filepath.Join(dir, "page")
	args := []string{"-jpeg", "-r", fmt.Sprintf("%d", dpi), "-jpegopt", "quality=90", pdfPath, prefix}
	cmd := exec.Command(c.Pdftoppm, args...)
	cmd.Env = os.Environ()
	cmd.Env = append(cmd.Env, "TMPDIR="+base)
	if c.LibDir != "" {
		cmd.Env = append(cmd.Env, "LD_LIBRARY_PATH="+c.LibDir+":"+os.Getenv("LD_LIBRARY_PATH"))
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("PDF 渲染失败：%v %s", err, strings.TrimSpace(string(out)))
	}
	matches, _ := filepath.Glob(prefix + "-*.jpg")
	sort.Strings(matches)
	if len(matches) == 0 {
		return nil, fmt.Errorf("PDF 渲染未生成图片")
	}
	return matches, nil
}

// Cleanup 删除临时文件。
func Cleanup(paths []string) {
	for _, p := range paths {
		_ = os.Remove(p)
	}
	if len(paths) > 0 {
		_ = os.Remove(filepath.Dir(paths[0]))
	}
}
