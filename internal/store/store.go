// Package store 提供打印助手的 SQLite 持久化层。
package store

import (
	"database/sql"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

// Printer 是已保存的打印机。
type Printer struct {
	ID        string `json:"id"`
	IP        string `json:"ip"`
	Name      string `json:"name"`
	Model     string `json:"model"`
	Protocol  string `json:"protocol"` // ipp / raw
	IsDefault bool   `json:"is_default"`
	CreatedAt string `json:"created_at"`
}

// Job 是一次打印任务。
type Job struct {
	ID         string `json:"id"`
	FilePath   string `json:"file_path"`
	FileName   string `json:"file_name"`
	PrinterIP  string `json:"printer_ip"`
	PrinterName string `json:"printer_name"`
	Copies     int    `json:"copies"`
	Paper      string `json:"paper"`  // A4 / Letter
	Duplex     bool   `json:"duplex"`
	Color      bool   `json:"color"`
	Scale      string `json:"scale"` // fit / actual
	Pages      string `json:"pages"` // 页码范围，如 1-3,5；空=全部
	Status     string `json:"status"` // queued / printing / done / failed / canceled
	Error      string `json:"error"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

// Store 是数据库句柄。
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  protocol TEXT DEFAULT 'ipp',
  is_default INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_path TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  printer_ip TEXT DEFAULT '',
  printer_name TEXT DEFAULT '',
  copies INTEGER DEFAULT 1,
  paper TEXT DEFAULT 'A4',
  duplex INTEGER DEFAULT 0,
  color INTEGER DEFAULT 0,
  scale TEXT DEFAULT 'fit',
  pages TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  path TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recents (
  path TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
`

// Open 打开数据库并初始化结构。
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// 旧库补列：列已存在时会报错，忽略即可
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN pages TEXT DEFAULT ''`)
	return &Store{db: db}, nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func columnExists(db *sql.DB, table, column string) bool {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return false
		}
		if name == column {
			return true
		}
	}
	return false
}

// ---------- settings ----------

func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, value, now())
	return err
}

func (s *Store) AllSettings() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key,value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ---------- printers ----------

func (s *Store) SavePrinter(p *Printer) error {
	if p.CreatedAt == "" {
		p.CreatedAt = now()
	}
	if p.ID == "" {
		p.ID = p.IP
	}
	_, err := s.db.Exec(`INSERT INTO printers(id,ip,name,model,protocol,is_default,created_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET ip=excluded.ip,name=excluded.name,model=excluded.model,protocol=excluded.protocol,is_default=excluded.is_default`,
		p.ID, p.IP, p.Name, p.Model, p.Protocol, boolInt(p.IsDefault), p.CreatedAt)
	return err
}

func (s *Store) ListPrinters() ([]Printer, error) {
	rows, err := s.db.Query(`SELECT id,ip,name,model,protocol,is_default,created_at FROM printers ORDER BY is_default DESC, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Printer
	for rows.Next() {
		var p Printer
		var def int
		if err := rows.Scan(&p.ID, &p.IP, &p.Name, &p.Model, &p.Protocol, &def, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.IsDefault = def == 1
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) SetDefaultPrinter(id string) error {
	if _, err := s.db.Exec(`UPDATE printers SET is_default=0`); err != nil {
		return err
	}
	_, err := s.db.Exec(`UPDATE printers SET is_default=1 WHERE id=?`, id)
	return err
}

func (s *Store) DeletePrinter(id string) error {
	_, err := s.db.Exec(`DELETE FROM printers WHERE id=?`, id)
	return err
}

// ---------- jobs ----------

func (s *Store) CreateJob(j *Job) error {
	if j.ID == "" {
		j.ID = NewID()
	}
	j.CreatedAt = now()
	j.UpdatedAt = j.CreatedAt
	if j.Status == "" {
		j.Status = "queued"
	}
	if j.Copies <= 0 {
		j.Copies = 1
	}
	if j.Paper == "" {
		j.Paper = "A4"
	}
	if j.Scale == "" {
		j.Scale = "fit"
	}
	_, err := s.db.Exec(`INSERT INTO jobs(id,file_path,file_name,printer_ip,printer_name,copies,paper,duplex,color,scale,pages,status,error,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		j.ID, j.FilePath, j.FileName, j.PrinterIP, j.PrinterName, j.Copies, j.Paper, boolInt(j.Duplex), boolInt(j.Color), j.Scale, j.Pages, j.Status, j.Error, j.CreatedAt, j.UpdatedAt)
	return err
}

func (s *Store) UpdateJobStatus(id, status, errMsg string) error {
	_, err := s.db.Exec(`UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?`, status, errMsg, now(), id)
	return err
}

func (s *Store) GetJob(id string) (Job, error) {
	var j Job
	err := s.db.QueryRow(`SELECT id,file_path,file_name,printer_ip,printer_name,copies,paper,duplex,color,scale,COALESCE(pages,''),status,error,created_at,updated_at
		FROM jobs WHERE id=?`, id).Scan(&j.ID, &j.FilePath, &j.FileName, &j.PrinterIP, &j.PrinterName,
		&j.Copies, &j.Paper, &j.Duplex, &j.Color, &j.Scale, &j.Pages, &j.Status, &j.Error, &j.CreatedAt, &j.UpdatedAt)
	return j, err
}

func (s *Store) ListJobs(limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT id,file_path,file_name,printer_ip,printer_name,copies,paper,duplex,color,scale,COALESCE(pages,''),status,error,created_at,updated_at
		FROM jobs ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		var j Job
		var dup, col int
		if err := rows.Scan(&j.ID, &j.FilePath, &j.FileName, &j.PrinterIP, &j.PrinterName,
			&j.Copies, &j.Paper, &dup, &col, &j.Scale, &j.Pages, &j.Status, &j.Error, &j.CreatedAt, &j.UpdatedAt); err != nil {
			return nil, err
		}
		j.Duplex = dup == 1
		j.Color = col == 1
		out = append(out, j)
	}
	return out, rows.Err()
}

// NextQueuedJob 取最早排队的任务。
func (s *Store) NextQueuedJob() (*Job, error) {
	var j Job
	var dup, col int
	err := s.db.QueryRow(`SELECT id,file_path,file_name,printer_ip,printer_name,copies,paper,duplex,color,scale,COALESCE(pages,''),status,error,created_at,updated_at
		FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).Scan(&j.ID, &j.FilePath, &j.FileName, &j.PrinterIP, &j.PrinterName,
		&j.Copies, &j.Paper, &dup, &col, &j.Scale, &j.Pages, &j.Status, &j.Error, &j.CreatedAt, &j.UpdatedAt)
	if err != nil {
		return nil, err
	}
	j.Duplex = dup == 1
	j.Color = col == 1
	return &j, nil
}

// CancelJob 取消排队中的任务。
func (s *Store) CancelJob(id string) error {
	_, err := s.db.Exec(`UPDATE jobs SET status='canceled',updated_at=? WHERE id=? AND status='queued'`, now(), id)
	return err
}

func (s *Store) RetryJob(id string) error {
	_, err := s.db.Exec(`UPDATE jobs SET status='queued',error='',updated_at=? WHERE id=? AND status IN ('failed','canceled')`, now(), id)
	return err
}

// ---------- favorites / recents ----------

func (s *Store) AddFavorite(path, name string) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO favorites(path,name,created_at) VALUES(?,?,?)`, path, name, now())
	return err
}

func (s *Store) RemoveFavorite(path string) error {
	_, err := s.db.Exec(`DELETE FROM favorites WHERE path=?`, path)
	return err
}

func (s *Store) ListFavorites() ([]map[string]string, error) {
	rows, err := s.db.Query(`SELECT path,name,created_at FROM favorites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var p, n, c string
		if err := rows.Scan(&p, &n, &c); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"path": p, "name": n, "created_at": c})
	}
	return out, rows.Err()
}

func (s *Store) TouchRecent(path, name string) error {
	_, err := s.db.Exec(`INSERT INTO recents(path,name,opened_at) VALUES(?,?,?)
		ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at`, path, name, now())
	return err
}

func (s *Store) ListRecents(limit int) ([]map[string]string, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(`SELECT path,name,opened_at FROM recents ORDER BY opened_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var p, n, c string
		if err := rows.Scan(&p, &n, &c); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"path": p, "name": n, "opened_at": c})
	}
	return out, rows.Err()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// NewID 生成随机任务 ID。
func NewID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12)
	for i := range b {
		b[i] = chars[time.Now().UnixNano()%int64(len(chars))]
		time.Sleep(time.Nanosecond)
	}
	return string(b)
}
