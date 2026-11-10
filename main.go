package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

func main() {
	listen := flag.String("listen", "127.0.0.1:8899", "HTTP listen address")
	peerURL := flag.String("peer-url", "", "Optional private LAN wired peer URL")
	wiredPeer := flag.Bool("wired-peer", false, "Identify this server as the wired test endpoint")
	flag.Parse()
	if *peerURL != "" {
		u, err := url.Parse(*peerURL)
		if err != nil || u.Scheme != "http" || u.User != nil || !net.ParseIP(u.Hostname()).IsPrivate() || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			log.Fatal("peer-url must be an HTTP URL with a private IP address")
		}
	}
	payload := make([]byte, 1024*1024)
	if _, err := rand.Read(payload); err != nil {
		log.Fatal(err)
	}
	var mu sync.Mutex
	var token, owner string
	var expires time.Time
	slots := make(chan struct{}, 6)
	jsonReply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		name, _ := os.Hostname()
		jsonReply(w, map[string]any{"hostname": name, "version": "1.0.2", "streams": 6, "duration": 8, "wired_peer": *wiredPeer, "peer_url": *peerURL})
	})
	mux.HandleFunc("POST /api/session", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if time.Now().Before(expires) || len(slots) != 0 {
			http.Error(w, "另一台设备正在测速，请稍后再试。", http.StatusConflict)
			return
		}
		var b [24]byte
		if _, err := rand.Read(b[:]); err != nil {
			http.Error(w, "无法创建测速会话", 500)
			return
		}
		token = hex.EncodeToString(b[:])
		owner, _, _ = net.SplitHostPort(r.RemoteAddr)
		expires = time.Now().Add(60 * time.Second)
		jsonReply(w, map[string]string{"token": token})
	})
	protected := func(transfer bool, h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ip, _, _ := net.SplitHostPort(r.RemoteAddr)
			mu.Lock()
			ok := token != "" && r.Header.Get("X-Speedtest-Token") == token && ip == owner && time.Now().Before(expires)
			mu.Unlock()
			if !ok {
				http.Error(w, "测速会话已过期，请重新开始。", 403)
				return
			}
			if transfer {
				select {
				case slots <- struct{}{}:
					defer func() { <-slots }()
				default:
					http.Error(w, "测速连接数已满", 429)
					return
				}
			}
			h(w, r)
		}
	}
	mux.HandleFunc("DELETE /api/session", protected(false, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		expires = time.Time{}
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /api/ping", protected(false, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	mux.HandleFunc("GET /api/download", protected(true, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		end := time.Now().Add(10 * time.Second)
		for time.Now().Before(end) {
			if r.Context().Err() != nil {
				return
			}
			if _, err := w.Write(payload); err != nil {
				return
			}
		}
	}))
	mux.HandleFunc("POST /api/upload", protected(true, func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 8*1024*1024)
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			http.Error(w, "上传未完成或超过 8 MiB", http.StatusBadRequest)
			return
		}
		jsonReply(w, map[string]int64{"bytes": n})
	}))
	web, _ := fs.Sub(assets, "web")
	mux.Handle("/", http.FileServer(http.FS(web)))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-transform")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		if r.Host != *listen {
			http.Error(w, "Invalid host", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "Cross-origin request blocked", 403)
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "Cross-site request blocked", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16384}
	stop, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-stop.Done()
		ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		_ = srv.Shutdown(ctx)
	}()
	log.Printf("W LAN Speed 1.0.2 listening on http://%s", *listen)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
