# CBI SmartIO - Deploy Railway

## Chạy local

```bash
python server.py --host 0.0.0.0 --port 8088 --layout data/sample_layout.json
```

Mở trình duyệt: `http://localhost:8088`

## Deploy lên Railway

### 1) Push source lên GitHub
Railway sẽ deploy từ repo GitHub.

### 2) Tạo project Railway
- Vào Railway → **New Project** → **Deploy from GitHub repo**.
- Chọn repository này.

### 3) Cấu hình start command
Repo đã có sẵn:
- `Procfile`
- `railway.json`

Nên Railway tự nhận lệnh chạy:

```bash
python server.py --host 0.0.0.0 --port $PORT --layout data/sample_layout.json
```

### 4) Domain và WebSocket
Sau khi deploy, lấy domain dạng:

`https://<your-app>.up.railway.app`

WebSocket endpoint tương ứng:

`wss://<your-app>.up.railway.app/smartio`

Trong giao diện web, ô WebSocket đã để trống mặc định và sẽ tự điền theo domain hiện tại.

### 5) Kiểm tra nhanh
- Mở URL app Railway.
- Badge chuyển `online` khi socket kết nối.
- Có thể nhập tay URL WebSocket nếu cần.

## Ghi chú
- `server.py` ưu tiên biến môi trường `PORT` (Railway cấp tự động).
- `data/sample_layout.json` là layout mặc định tối thiểu để app khởi động được.
