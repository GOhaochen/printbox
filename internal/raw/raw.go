// Package raw 实现 RAW 9100 直传（把 PDF/图片原始数据流直接发送给打印机）。
package raw

import (
	"fmt"
	"net"
	"time"
)

// Print 通过 9100 端口发送数据。
func Print(ip string, data []byte) error {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip, "9100"), 10*time.Second)
	if err != nil {
		return fmt.Errorf("连接打印机 9100 端口失败：%w", err)
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(60 * time.Second))
	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("发送打印数据失败：%w", err)
	}
	return nil
}

// Probe 测试 9100 端口是否开放。
func Probe(ip string, timeout time.Duration) bool {
	if timeout <= 0 {
		timeout = 600 * time.Millisecond
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip, "9100"), timeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
