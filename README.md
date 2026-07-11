# SONAR ポータル — セットアップ手順

はじめてでも順番どおりにやれば動きます。所要 30〜45分。

---

## 全体の流れ

1. **Supabase** を用意する（データの保存先＋ログイン機能。無料）
2. アプリに Supabase の「住所」と「鍵」を書き込む
3. **パソコンで動作確認**する
4. **ネットに公開**して、みんなが使えるようにする（無料）

---

# ステップ1：Supabase を用意する

### 1-1. アカウントとプロジェクトを作る

1. https://supabase.com を開き、右上「**Start your project**」
2. GitHub か メールでサインアップ（無料）
3. 「**New project**」をクリック
   - **Name**: 好きな名前（例: `sonar`）
   - **Database Password**: 強めのパスワードを入力（**メモしておく**）
   - **Region**: `Northeast Asia (Tokyo)` を選ぶ
4. 「**Create new project**」→ 1〜2分待つ

### 1-2. 「住所」と「鍵」をコピーする

1. 左メニュー下の **⚙ Project Settings** → **API**
2. 次の2つをメモ帳などにコピー：
   - **Project URL** … `https://xxxxx.supabase.co` のような文字列
   - **anon public** … `eyJ...` で始まる長い文字列

### 1-3. データの置き場所を作る

1. 左メニュー **SQL Editor** → 「**New query**」
2. 下のSQLをまるごと貼り付けて、右下「**Run**」

```sql
create table if not exists public.portals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.portals enable row level security;
create policy "own select" on public.portals for select using (auth.uid() = user_id);
create policy "own insert" on public.portals for insert with check (auth.uid() = user_id);
create policy "own update" on public.portals for update using (auth.uid() = user_id);
```

「Success. No rows returned」と出れば成功。

### 1-4. メール確認をオフにする（おすすめ）

1. 左メニュー **Authentication** → **Sign In / Providers** → **Email**
2. 「**Confirm email**」を **オフ** にして保存

※ これで登録後すぐログインできます。オンのままだと確認メールのリンクを踏む必要があります。

---

# ステップ2：アプリに住所と鍵を書き込む

`src/App.jsx` をメモ帳などで開き、**先頭のほうにある次の2行**を探します（16行目あたり）。

```js
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
```

ステップ1-2でコピーした値に置き換えて、保存します。

```js
const SUPABASE_URL = "https://xxxxx.supabase.co";        // ← Project URL
const SUPABASE_ANON_KEY = "eyJhbGciOi...";               // ← anon public
```

※ anon キーは公開して良いキーです。ステップ1-3の設定で、他人のデータは見えません。

---

# ステップ3：パソコンで動作確認

1. Node.js を入れる（未インストールなら）→ https://nodejs.org の「**LTS**」版
2. **このフォルダ**（package.json がある場所）をコマンドプロンプトで開く
   - エクスプローラーでフォルダを開き、上のアドレスバーに `cmd` と入力して Enter
3. 次を実行：

```
npm install
npm run dev
```

4. 表示された `http://localhost:5173/` をブラウザで開く

**ログイン画面が出れば成功！** 「アカウントを新規作成」から登録して使えます。

（止めるときは、コマンドプロンプトで Ctrl+C）

---

# ステップ4：ネットに公開する（無料）

### 4-1. GitHub にアップロード

1. https://github.com でアカウント作成（無料）
2. 右上「**+**」→「**New repository**」
   - Repository name: `sonar`（好きな名前）
   - **Public** のまま
   - 「Create repository」
3. 次の画面で「**uploading an existing file**」をクリック
4. **このフォルダの中身**（README.md, index.html, package.json, vite.config.js, src フォルダ）を
   ドラッグ&ドロップ
   - ※ `node_modules` フォルダは**アップロードしない**（あれば除外）
5. 下の「**Commit changes**」

### 4-2. Vercel で公開

1. https://vercel.com を開き、「**Continue with GitHub**」でログイン
2. 「**Add New...**」→「**Project**」
3. さきほどのリポジトリ（`sonar`）の「**Import**」をクリック
4. 設定はそのままで「**Deploy**」
5. 1〜2分で完了 → `https://sonar-xxxx.vercel.app` のURLが発行されます

**このURLを開けば、どこからでも使えます。**
他の人に渡せば、その人も自分のメールで登録して、**自分専用のポータル**として使えます。

---

## うまくいかないときは

| 症状 | 対処 |
|---|---|
| 「Supabase の設定が必要です」画面 | ステップ2の2行が置き換わっていません |
| 登録できるがログインできない | ステップ1-4（メール確認オフ）を確認 |
| 保存されない（雲マークに斜線） | ステップ1-3のSQLを実行したか確認 |
| `npm` が見つからない | Node.js を入れた後、コマンドプロンプトを開き直す |

---

## 使い方メモ
- 予定・カテゴリ・ショートカット・地点・テーマはすべて自動保存されます
- 右上の雲マーク＝同期中
- ログアウトは右上のアイコンから
