// Package discover 扫描局域网，发现支持 IPP/AirPrint 或 RAW 9100 的打印机。
package discover

import (
	"fmt"
	"net"
	"sort"
	"sync"
	"time"

	"printbox/internal/ipp"
	"printbox/internal/raw"
)

// Found 是一台被发现的打印机。
type Found struct {
	IP       string `json:"ip"`
	Name     string `json:"name"`
	Model    string `json:"model"`
	IPP      bool   `json:"ipp"`
	RAW      bool   `json:"raw"`
	Protocol string `json:"protocol"` // ipp / raw
}

// Scan 并发探测给定主机列表。
func Scan(hosts []string) []Found {
	var mu sync.Mutex
	var out []Found
	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)
	for _, ip := range hosts {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			f := probe(ip)
			if f.IPP || f.RAW {
				mu.Lock()
				out = append(out, f)
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	return out
}

func probe(ip string) Found {
	f := Found{IP: ip}
	// 先尝试 IPP：能取到状态说明是标准网络打印机
	client := ipp.New(ip)
	client.HTTP.Timeout = 800 * time.Millisecond
	if st, err := client.GetStatus(); err == nil {
		f.IPP = true
		f.Name = st.Name
		f.Model = st.Model
		if f.Name == "" {
			f.Name = "IPP 打印机"
		}
	}
	// RAW 端口
	f.RAW = raw.Probe(ip, 500*time.Millisecond)
	if f.IPP {
		f.Protocol = "ipp"
	} else if f.RAW {
		f.Protocol = "raw"
		f.Name = "RAW 打印机"
	}
	return f
}

// LocalHosts 返回本机所在 /24 网段的主机地址。
func LocalHosts() []string {
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
