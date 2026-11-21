// Package ipp 实现最小可用的 IPP（Internet Printing Protocol）客户端，
// 支持 Print-Job 与 Get-Printer-Attributes，用于直连支持 AirPrint/IPP 的打印机。
package ipp

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 操作码
const (
	OpPrintJob             = 0x0002
	OpGetPrinterAttributes = 0x000B
)

// 属性标签
const (
	tagCharset        = 0x47
	tagNaturalLang    = 0x48
	tagURI            = 0x45
	tagName           = 0x42
	tagKeyword        = 0x44
	tagMimeType       = 0x49
	tagInteger        = 0x21
	tagEnum           = 0x23
	tagText           = 0x41
)

// PrinterStatus 是打印机状态摘要。
type PrinterStatus struct {
	State      string   `json:"state"`      // idle / processing / stopped / unknown
	Reasons    []string `json:"reasons"`
	Name       string   `json:"name"`
	Model      string   `json:"model"`
	Formats    []string `json:"formats"`
}

// Options 是打印参数。
type Options struct {
	Copies int
	Paper  string // A4 / Letter
	Duplex bool
	Color  bool
	Scale  string // fit / actual
}

// Client 是 IPP 打印机客户端。
type Client struct {
	IP   string
	Path string
	URI  string // 打印机声明的 printer-uri，优先使用
	HTTP *http.Client
}

// New 创建客户端，默认使用 /ipp/print。
func New(ip string) *Client {
	return &Client{IP: ip, Path: "/ipp/print", HTTP: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Client) url() string {
	host, path := c.IP, c.Path
	if c.URI != "" {
		if u, err := urlParse(c.URI); err == nil {
			if u.host != "" {
				host = u.host
			}
			if u.path != "" {
				path = u.path
			}
		}
	}
	return "http://" + host + ":631" + path
}

// Capability 是打印机能力摘要。
type Capability struct {
	URI     string   `json:"uri"`
	Formats []string `json:"formats"`
}

// GetCapability 读取打印机声明的 URI 与支持的文档格式。
func (c *Client) GetCapability() (Capability, error) {
	var attrs []byte
	attrs = append(attrs, attr(tagCharset, "attributes-charset", "utf-8")...)
	attrs = append(attrs, attr(tagNaturalLang, "attributes-natural-language", "en")...)
	attrs = append(attrs, attr(tagURI, "printer-uri", "ipp://"+c.IP+":631"+c.Path)...)

	body := request(OpGetPrinterAttributes, 3, attrs)
	req, err := http.NewRequest(http.MethodPost, c.url(), bytes.NewReader(body))
	if err != nil {
		return Capability{}, err
	}
	req.Header.Set("Content-Type", "application/ipp")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Capability{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	code, groups := parseStatus(data)
	if code != 0 {
		return Capability{}, fmt.Errorf("IPP 状态码 0x%04x", code)
	}
	cap := Capability{}
	for _, g := range groups {
		for _, a := range g {
			switch a.Name {
			case "printer-uri-supported":
				if cap.URI == "" {
					cap.URI = a.Value
				}
			case "document-format-supported":
				cap.Formats = append(cap.Formats, a.Value)
			}
		}
	}
	return cap, nil
}

// Supports 判断是否支持某文档格式。
func (c Capability) Supports(format string) bool {
	for _, f := range c.Formats {
		if strings.EqualFold(f, format) {
			return true
		}
	}
	return false
}

// urlParse 是 ipp URI 的极简解析。
type ippURI struct{ host, path string }

func urlParse(raw string) (ippURI, error) {
	var out ippURI
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/"); i >= 0 {
		out.host = s[:i]
		out.path = s[i:]
	} else {
		out.host = s
		out.path = "/ipp/print"
	}
	if out.host == "" {
		return out, fmt.Errorf("bad uri")
	}
	return out, nil
}

// 属性构造辅助
func attr(tag byte, name, value string) []byte {
	b := []byte{tag}
	b = append(b, byte(len(name)>>8), byte(len(name)))
	b = append(b, name...)
	b = append(b, byte(len(value)>>8), byte(len(value)))
	b = append(b, value...)
	return b
}

func intAttr(tag byte, name string, v int32) []byte {
	b := []byte{tag}
	b = append(b, byte(len(name)>>8), byte(len(name)))
	b = append(b, name...)
	b = append(b, 0, 4)
	val := make([]byte, 4)
	binary.BigEndian.PutUint32(val, uint32(v))
	b = append(b, val...)
	return b
}

func request(op uint16, requestID uint32, attrs []byte) []byte {
	buf := []byte{0x01, 0x01}
	opb := make([]byte, 2)
	binary.BigEndian.PutUint16(opb, op)
	buf = append(buf, opb...)
	idb := make([]byte, 4)
	binary.BigEndian.PutUint32(idb, requestID)
	buf = append(buf, idb...)
	buf = append(buf, 0x01) // operation attributes group
	buf = append(buf, attrs...)
	buf = append(buf, 0x03) // end of attributes
	return buf
}

// Print 发送打印任务；format 为空时按 PDF 处理。
func (c *Client) Print(filename string, data []byte, format string, opt Options) error {
	if format == "" {
		format = "application/pdf"
	}
	if opt.Copies <= 0 {
		opt.Copies = 1
	}
	if opt.Paper == "" {
		opt.Paper = "A4"
	}
	var opAttrs []byte
	opAttrs = append(opAttrs, attr(tagCharset, "attributes-charset", "utf-8")...)
	opAttrs = append(opAttrs, attr(tagNaturalLang, "attributes-natural-language", "en")...)
	opAttrs = append(opAttrs, attr(tagURI, "printer-uri", "ipp://"+c.IP+":631"+c.Path)...)
	opAttrs = append(opAttrs, attr(tagName, "requesting-user-name", "printbox")...)
	opAttrs = append(opAttrs, attr(tagName, "job-name", filename)...)
	opAttrs = append(opAttrs, attr(tagMimeType, "document-format", format)...)

	var jobAttrs []byte
	jobAttrs = append(jobAttrs, intAttr(tagInteger, "copies", int32(opt.Copies))...)
	paper := "iso_a4_210x297mm"
	if strings.EqualFold(opt.Paper, "Letter") {
		paper = "na_letter_8.5x11in"
	}
	jobAttrs = append(jobAttrs, attr(tagKeyword, "media", paper)...)
	sides := "one-sided"
	if opt.Duplex {
		sides = "two-sided-long-edge"
	}
	jobAttrs = append(jobAttrs, attr(tagKeyword, "sides", sides)...)
	colorMode := "monochrome"
	if opt.Color {
		colorMode = "color"
	}
	jobAttrs = append(jobAttrs, attr(tagKeyword, "print-color-mode", colorMode)...)
	scaling := "fit"
	if strings.EqualFold(opt.Scale, "actual") {
		scaling = "none"
	}
	jobAttrs = append(jobAttrs, attr(tagKeyword, "print-scaling", scaling)...)

	body := []byte{0x01, 0x01}
	opb := make([]byte, 2)
	binary.BigEndian.PutUint16(opb, OpPrintJob)
	body = append(body, opb...)
	body = append(body, 0, 0, 0, 1) // request-id
	body = append(body, 0x01)       // operation attributes group
	body = append(body, opAttrs...)
	body = append(body, 0x02) // job attributes group
	body = append(body, jobAttrs...)
	body = append(body, 0x03) // end of attributes
	body = append(body, data...)

	req, err := http.NewRequest(http.MethodPost, c.url(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("连接打印机失败：%w", err)
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("打印机返回 HTTP %d", resp.StatusCode)
	}
	code, _ := parseStatus(respData)
	if code != 0 {
		return fmt.Errorf("IPP 状态码 0x%04x（打印被拒绝）", code)
	}
	return nil
}

// GetStatus 查询打印机状态。
func (c *Client) GetStatus() (PrinterStatus, error) {
	var attrs []byte
	attrs = append(attrs, attr(tagCharset, "attributes-charset", "utf-8")...)
	attrs = append(attrs, attr(tagNaturalLang, "attributes-natural-language", "en")...)
	attrs = append(attrs, attr(tagURI, "printer-uri", "ipp://"+c.IP+":631"+c.Path)...)

	body := request(OpGetPrinterAttributes, 2, attrs)
	req, err := http.NewRequest(http.MethodPost, c.url(), bytes.NewReader(body))
	if err != nil {
		return PrinterStatus{}, err
	}
	req.Header.Set("Content-Type", "application/ipp")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return PrinterStatus{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return PrinterStatus{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	code, groups := parseStatus(data)
	if code != 0 {
		return PrinterStatus{}, fmt.Errorf("IPP 状态码 0x%04x", code)
	}
	st := PrinterStatus{State: "unknown"}
	for _, g := range groups {
		for _, a := range g {
			switch a.Name {
			case "printer-state":
				switch a.IntVal {
				case 3:
					st.State = "idle"
				case 4:
					st.State = "processing"
				case 5:
					st.State = "stopped"
				}
			case "printer-state-reasons":
				if a.Value != "none" {
					st.Reasons = append(st.Reasons, a.Value)
				}
			case "printer-name":
				st.Name = a.Value
			case "printer-make-and-model":
				st.Model = a.Value
			case "document-format-supported":
				st.Formats = append(st.Formats, a.Value)
			}
		}
	}
	return st, nil
}

type parsedAttr struct {
	Name   string
	Value  string
	IntVal int32
}

// parseStatus 解析 IPP 响应：返回状态码与属性组。
func parseStatus(data []byte) (uint16, [][]parsedAttr) {
	if len(data) < 8 {
		return 0x0400, nil
	}
	code := binary.BigEndian.Uint16(data[2:4])
	var groups [][]parsedAttr
	var cur []parsedAttr
	lastName := ""
	i := 8
	for i < len(data) {
		tag := data[i]
		if tag == 0x03 {
			if len(cur) > 0 {
				groups = append(groups, cur)
				cur = nil
			}
			break
		}
		if tag <= 0x0F { // 组标签
			if len(cur) > 0 {
				groups = append(groups, cur)
				cur = nil
			}
			i++
			continue
		}
		if i+2 > len(data) {
			break
		}
		nameLen := int(binary.BigEndian.Uint16(data[i+1 : i+3]))
		i += 3
		if i+nameLen > len(data) {
			break
		}
		name := string(data[i : i+nameLen])
		if nameLen == 0 {
			name = lastName
		}
		lastName = name
		i += nameLen
		if i+2 > len(data) {
			break
		}
		valLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if i+valLen > len(data) {
			break
		}
		raw := data[i : i+valLen]
		i += valLen
		a := parsedAttr{Name: name, Value: string(raw)}
		if tag == tagInteger || tag == tagEnum {
			if len(raw) >= 4 {
				a.IntVal = int32(binary.BigEndian.Uint32(raw[:4]))
			}
		}
		cur = append(cur, a)
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	return code, groups
}

// StatusText 把状态码转为可读文本。
func StatusText(code uint16) string {
	switch code {
	case 0:
		return "成功"
	case 0x0400:
		return "打印机忙或参数错误"
	case 0x0401:
		return "打印机不支持该格式"
	case 0x0404:
		return "打印机不可用"
	case 0x0406:
		return "文档格式错误"
	case 0x0407:
		return "文档数据错误"
	case 0x0500:
		return "打印机内部错误"
	default:
		return "错误码 0x" + strconv.FormatUint(uint64(code), 16)
	}
}
