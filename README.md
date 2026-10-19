# 化原期中互動複習題卡

這是一個可直接部署到 GitHub Pages 的靜態網站，包含：

- 130 題考古原題
- 32 題統整練習
- 單選、多選與非選題
- 題目附圖
- 答錯自動加入星號
- 星號題目練習
- 題目總覽、搜尋與作答紀錄
- 可由首頁直接開啟、持續更新的化原筆記
- 瀏覽器本機進度儲存
- 可選用的 Supabase 帳號與跨裝置同步

## GitHub Pages 必要結構

請保持以下相對位置，不要只上傳 `index.html`：

```text
chemistry-midterm-web/
├─ index.html
├─ notes.html
├─ app.js
├─ style.css
├─ config.js
├─ config.example.js
├─ .nojekyll
├─ supabase-schema.sql
├─ README.md
├─ data/
│  ├─ exam.json
│  ├─ practice.json
│  └─ manifest.json
└─ assets/
   ├─ exam3-q01-03-mo.jpg
   └─ exam3-q05-ruler.jpg
```

## GitHub Pages 發布

1. 在 GitHub 建立一個新的 public repository，例如 `chemistry-midterm-review`。
2. 將本資料夾內的所有檔案與資料夾上傳到 repository 根目錄。
3. 開啟 repository 的 **Settings → Pages**。
4. 在 **Build and deployment** 中選擇 **Deploy from a branch**。
5. Branch 選 `main`，資料夾選 `/ (root)`，按 **Save**。
6. 等候 GitHub 完成部署，網址通常會是：
   `https://你的帳號.github.io/chemistry-midterm-review/`

## 跨裝置同步（選用）

不設定 Supabase 也能正常使用，進度會存在目前瀏覽器。

若要跨手機與電腦同步：

1. 建立 Supabase project。
2. 在 Supabase SQL Editor 執行 `supabase-schema.sql`。
3. 到 Project Settings 取得 Project URL 與 publishable/anon key。
4. 將資料填入 `config.js`。
5. 重新上傳更新後的 `config.js`。

`service_role` key 擁有高權限，絕對不要放進 GitHub 或瀏覽器程式。

## 本機預覽

因為瀏覽器會讀取 JSON 題庫，不要直接雙擊 `index.html`。可以在本資料夾啟動本機伺服器，例如：

```powershell
python -m http.server 8000
```

再開啟 `http://localhost:8000/`。
