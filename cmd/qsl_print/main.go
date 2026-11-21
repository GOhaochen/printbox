// 打印助手：通过 NAS 直连局域网打印机，完成 PDF/图片打印。
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"printbox/internal/api"
	"printbox/internal/discover"
	"printbox/internal/store"
)

const version = "0.2.5"

func main() {
	addr := flag.String("addr", ":21020", "监听地址")
	dataDir := flag.String("data", "./data", "数据目录")
	sharedDir := flag.String("storage", "", "授权共享目录（可选）")
	webDir := flag.String("web", "./web", "前端目录")
	flag.Parse()

	_ = os.MkdirAll(*dataDir, 0o755)
	dbPath := filepath.Join(*dataDir, "printbox.db")
	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败：%v", err)
	}
	defer st.Close()

	if *sharedDir == "" {
		if v := os.Getenv("UGAPP_SHARED_DIR"); v != "" {
			*sharedDir = v
		}
	}
	exe, _ := os.Executable()
	binDir := filepath.Dir(exe)
	pdftoppm := filepath.Join(binDir, "pdftoppm")
	if _, err := os.Stat(pdftoppm); err != nil {
		if p, err2 := exec.LookPath("pdftoppm"); err2 == nil {
			pdftoppm = p
		} else {
			pdftoppm = ""
		}
	}
	libDir := filepath.Join(binDir, "..", "lib")
	if _, err := os.Stat(libDir); err != nil {
		libDir = ""
	}
	tmpDir := filepath.Join(*dataDir, "tmp")
	_ = os.MkdirAll(tmpDir, 0o755)
	cfg := api.Config{
		DataDir:      *dataDir,
		TmpDir:       tmpDir,
		SharedDir:    *sharedDir,
		WebDir:       *webDir,
		Version:      version,
		PdftoppmPath: pdftoppm,
		LibDir:       libDir,
	}
	srv := api.New(cfg, st)
	srv.StartWorker()

	// 启动时异步探测默认打印机状态，便于前端展示
	go func() {
		time.Sleep(2 * time.Second)
		for _, ip := range discover.LocalHosts() {
			_ = ip
			break
		}
	}()

	log.Printf("打印助手 %s 启动：http://%s 数据目录=%s 共享目录=%s pdftoppm=%s", version, *addr, *dataDir, *sharedDir, cfg.PdftoppmPath)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("服务启动失败：%v", err)
	}
}
