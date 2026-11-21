// Package escl 实现 eSCL（AirScan）扫描协议客户端，用于直接驱动网络扫描仪。
package escl

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client 是 eSCL 设备客户端。
type Client struct {
	BaseURL string // 例如 http://192.168.3.161
	HTTP    *http.Client
}

// New 创建客户端。
func New(baseURL string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	return &Client{
		BaseURL: baseURL,
		HTTP:    &http.Client{Timeout: 150 * time.Second},
	}
}

// Status 是扫描仪状态。
type Status struct {
	Version string `json:"version"`
	State   string `json:"state"`
	Raw     string `json:"-"`
}

type xmlStatus struct {
	Version string `xml:"Version"`
	State   string `xml:"State"`
}

// GetStatus 读取扫描仪状态。
func (c *Client) GetStatus() (Status, error) {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/eSCL/ScannerStatus", nil)
	if err != nil {
		return Status{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Status{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Status{}, fmt.Errorf("读取扫描仪状态失败：HTTP %d", resp.StatusCode)
	}
	var s xmlStatus
	if err := xml.Unmarshal(body, &s); err != nil {
		return Status{State: "unknown", Raw: string(body)}, nil
	}
	return Status{Version: s.Version, State: s.State, Raw: string(body)}, nil
}

// Capabilities 是扫描能力摘要。
type Capabilities struct {
	Version      string  `json:"version"`
	MaxWidth     int     `json:"max_width"`
	MaxHeight    int     `json:"max_height"`
	Resolutions  []int   `json:"resolutions"`
	ColorModes   []string `json:"color_modes"`
	Formats      []string `json:"formats"`
}

type xmlCaps struct {
	Version   string `xml:"Version"`
	MaxWidth  int    `xml:"MaxWidth"`
	MaxHeight int    `xml:"MaxHeight"`
	Resolutions []struct {
		X int `xml:"XResolution"`
		Y int `xml:"YResolution"`
	} `xml:"ResolutionRange>XResolution"` // 兜底
}

// GetCapabilities 读取并解析能力集。
func (c *Client) GetCapabilities() (Capabilities, error) {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/eSCL/ScannerCapabilities", nil)
	if err != nil {
		return Capabilities{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Capabilities{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Capabilities{}, fmt.Errorf("读取扫描能力失败：HTTP %d", resp.StatusCode)
	}
	caps := Capabilities{Version: extractTag(string(body), "Version")}
	caps.MaxWidth, _ = strconv.Atoi(extractTag(string(body), "MaxWidth"))
	caps.MaxHeight, _ = strconv.Atoi(extractTag(string(body), "MaxHeight"))
	// 解析所有 XResolution 值（去重）
	seen := map[int]bool{}
	rest := string(body)
	for {
		v, ok := extractTagOK(rest, "XResolution")
		if !ok {
			break
		}
		n, _ := strconv.Atoi(v)
		if n > 0 && !seen[n] {
			seen[n] = true
			caps.Resolutions = append(caps.Resolutions, n)
		}
		idx := strings.Index(rest, "<scan:XResolution>")
		if idx < 0 {
			idx = strings.Index(rest, "<XResolution>")
		}
		if idx < 0 {
			break
		}
		next := strings.Index(rest[idx+1:], "Resolution>")
		if next < 0 {
			break
		}
		rest = rest[idx+next+len("Resolution>"):]
	}
	if len(caps.Resolutions) == 0 {
		caps.Resolutions = []int{75, 100, 200, 300, 600, 1200}
	}
	for _, m := range []string{"Grayscale8", "RGB24", "BlackAndWhite1"} {
		if strings.Contains(string(body), m) {
			caps.ColorModes = append(caps.ColorModes, m)
		}
	}
	for _, f := range []string{"image/jpeg", "application/pdf"} {
		if strings.Contains(string(body), f) {
			caps.Formats = append(caps.Formats, f)
		}
	}
	return caps, nil
}

func extractTagOK(s, tag string) (string, bool) {
	open := "<scan:" + tag + ">"
	if !strings.Contains(s, open) {
		open = "<" + tag + ">"
	}
	i := strings.Index(s, open)
	if i < 0 {
		return "", false
	}
	rest := s[i+len(open):]
	j := strings.Index(rest, "<")
	if j < 0 {
		return "", false
	}
	return strings.TrimSpace(rest[:j]), true
}

func extractTag(s, tag string) string {
	v, _ := extractTagOK(s, tag)
	return v
}

// ScanOptions 定义扫描参数。
type ScanOptions struct {
	DPI      int
	ColorMode string // RGB24 / Grayscale8
	Format   string // image/jpeg
	Width    int    // 1/300 英寸单位
	Height   int
}

// DefaultScanOptions 返回默认参数（A4、300dpi、彩色、JPEG）。
func DefaultScanOptions() ScanOptions {
	return ScanOptions{
		DPI:       300,
		ColorMode: "RGB24",
		Format:    "image/jpeg",
		Width:     2480,
		Height:    3508,
	}
}

// Scan 触发一次扫描，返回图像二进制。
func (c *Client) Scan(opt ScanOptions) ([]byte, string, error) {
	if opt.DPI <= 0 {
		opt.DPI = 300
	}
	if opt.ColorMode == "" {
		opt.ColorMode = "RGB24"
	}
	if opt.Format == "" {
		opt.Format = "image/jpeg"
	}
	if opt.Width <= 0 {
		opt.Width = 2480
	}
	if opt.Height <= 0 {
		opt.Height = 3508
	}
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.5</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:Width>%d</pwg:Width>
      <pwg:Height>%d</pwg:Height>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:DocumentFormat>%s</pwg:DocumentFormat>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <scan:DocumentFormatExt>%s</scan:DocumentFormatExt>
  <scan:XResolution>%d</scan:XResolution>
  <scan:YResolution>%d</scan:YResolution>
  <scan:ColorMode>%s</scan:ColorMode>
  <scan:CompressionFactor>25</scan:CompressionFactor>
</scan:ScanSettings>`, opt.Width, opt.Height, opt.Format, opt.Format, opt.DPI, opt.DPI, opt.ColorMode)

	req, err := http.NewRequest(http.MethodPost, c.BaseURL+"/eSCL/ScanJobs", bytes.NewBufferString(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "text/xml")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("提交扫描任务失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, "", fmt.Errorf("打印机遇拒任务：HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		return nil, "", fmt.Errorf("扫描任务未返回 Location 头")
	}
	if strings.HasPrefix(loc, "/") {
		loc = c.BaseURL + loc
	}
	if !strings.HasSuffix(loc, "/NextDocument") {
		loc = strings.TrimRight(loc, "/") + "/NextDocument"
	}

	// 轮询取图：扫描期间可能需要等待
	deadline := time.Now().Add(140 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		r, err := http.NewRequest(http.MethodGet, loc, nil)
		if err != nil {
			return nil, "", err
		}
		rr, err := c.HTTP.Do(r)
		if err != nil {
			lastErr = err
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		data, err := io.ReadAll(rr.Body)
		rr.Body.Close()
		if err == nil && rr.StatusCode == http.StatusOK && len(data) > 0 {
			return data, loc, nil
		}
		if rr.StatusCode == http.StatusServiceUnavailable || rr.StatusCode == http.StatusNotFound {
			lastErr = fmt.Errorf("取图未就绪：HTTP %d", rr.StatusCode)
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		lastErr = fmt.Errorf("取图失败：HTTP %d", rr.StatusCode)
		time.Sleep(1500 * time.Millisecond)
	}
	return nil, loc, fmt.Errorf("等待扫描图超时：%v", lastErr)
}
