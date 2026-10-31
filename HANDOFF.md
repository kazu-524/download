# 引き継ぎメモ: Mac に Codex プラグインを入れて、Claude Pro と ChatGPT Plus で負荷を分散する

- 作成日: 2026-10-31
- 作成者: クラウドセッションの Claude(ユーザーとの相談内容をまとめたもの)
- 読む人: ユーザーの Mac のローカルセッションで動く Claude Code

このメモの手順に沿って、ユーザーと一緒に Mac へ導入を進めてください。情報は 2026-10-31 時点のものです。特にモデル名やコマンドは変わりやすいので、実行前に手元で確認してください。

---

## 1. 目的

- Claude Pro だと、Claude Code の5時間制限に頻繁に当たる。
- ただし Max($100)を契約するほどは使わないので、ChatGPT Plus($20)を併用して負荷を分散したい。
- そのために、OpenAI 公式の **Codex プラグイン(`openai/codex-plugin-cc`)** を Mac の Claude Code に入れる。レビューや重い作業を Codex(ChatGPT Plus の枠)に回せるようにする。

## 2. ユーザーの環境と前提

| 項目 | 状態 |
|---|---|
| PC | Mac |
| 使っている Claude | Claude デスクトップアプリ(Code タブ)。ターミナル版 Claude Code があるかは未確認 |
| Claude の契約 | Pro |
| ChatGPT の契約 | Plus を併用する予定(契約済みかは要確認) |
| 住んでいる国 | 日本(Claude Duet などの米国限定機能は使えない) |

## 3. これまでに決まったこと・分かったこと

### 採用したもの
- **Codex plugin for Claude Code**(OpenAI 公式、無料、2026-03-31 公開)
  - Claude Code の中から Codex を呼び出せる。Codex 側は ChatGPT の契約(Plus)の枠で動く。
  - リポジトリ: https://github.com/openai/codex-plugin-cc

### 採用しなかったもの
- **Claude の契約を他社ツールで使えるようにする非公式ツール:** Anthropic の規約違反で、アカウント停止のおそれがある。Claude の契約(OAuth)が使えるのは、公式アプリと公式の Claude Code だけ。
- **Gemini との連携:** Gemini CLI は 2026-06-18 から個人の Google アカウントで使えなくなった(後継は Antigravity CLI。未調査)。
- **Sign in with ChatGPT の Notion 連携:** Notion の Business 以上のプランが必要で、メリットが小さい。

### プラグインが使える場所
- 使える: デスクトップアプリの Code タブの**ローカルセッション**、ターミナル版 Claude Code、VS Code。この3つは同じ設定ファイル(`~/.claude/settings.json` など)を読むので、どれか1つでユーザースコープに入れれば、ほかでも使える。
- 使えない: クラウドセッション、WSL セッション(Mac なので WSL は関係ない)。

### プラグインの中身(ソースコードで確認済み)
- `/codex:rescue`: サブエージェント `codex:codex-rescue`(`model: sonnet`、使うツールは Bash のみ)が、`codex-companion.mjs task ...` を1回実行して Codex に作業を渡す。調査や修正の本体は Codex がやる。初期設定は書き込みありの実行(`--write`)。
- `/codex:review`: Claude は `git status` と `git diff --shortstat` で変更の大きさを見るだけで、レビュー自体は Codex がやる。読むだけで、修正はしない。
- **Codex の出力は、そのまま Claude の会話に入る。** 出力が長いほど、Claude 側のトークンを使う。
- **review gate(Stop フック):** Claude が作業を終えるたびに Codex にレビューさせ、問題があれば Claude に直させる。Claude 側の消費が増えるので、**オフのまま**にする。
- `codex:codex-rescue` は「Claude が詰まったとき」などに自動で使われることがある。そのときも Plus の枠が減る。

### Codex のモデル(2026-10 時点。名前は頻繁に変わる)

| モデル | 向いている作業 | Plus での使える量 |
|---|---|---|
| Astra | 一番難しい問題 | とても少ない |
| Sol | 普段のコーディング(今の初期設定とされる) | 普通 |
| Terra | Sol と Luna の中間 | 普通〜多め |
| Luna | 簡単な作業 | とても多い |

## 4. 導入手順

### ローカルの Claude へのお願い
- `codex login` はブラウザでのログインが必要なので、**ユーザー本人に実行してもらう**。
- `/plugin`、`/reload-plugins`、`/codex:setup` などの**スラッシュコマンドは、ユーザーがプロンプト欄に入力する**。必要なタイミングで、何を入力すればいいかを伝える。
- `npm install -g` には **`sudo` を付けない**。
- `~/.codex/config.toml` がすでにある場合は**上書きしない**。中身をユーザーと確認してから変える。
- 何かを入れる前に、必ず現状を確認する(すでに入っているものは入れ直さない)。

### 4-1. 現状を確認する

```bash
sw_vers
```

```bash
brew -v
```

```bash
node -v
```

```bash
codex --version
```

```bash
claude --version
```

### 4-2. 足りないものを入れる

Homebrew がない場合(最後に表示される「Next steps」のコマンドも実行する):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Node.js がない場合:

```bash
brew install node
```

Codex がない場合:

```bash
npm install -g @openai/codex
```

ターミナル版 Claude Code がない場合(デスクトップアプリだけでも使えるが、下の `claude plugin install` を使うにはターミナル版が必要):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

### 4-3. Codex に ChatGPT でログインする(ユーザーが実行する)

```bash
codex login
```

### 4-4. プラグインを入れる

ターミナルから入れる場合(Claude Code v2.1.292 以降):

```bash
claude plugin install codex --marketplace openai/codex-plugin-cc
```

上のコマンドがうまくいかない場合は、ユーザーが Claude Code のセッションで次を1つずつ入力する。スコープを聞かれたら **Install for you (user scope)** を選ぶ。

```
/plugin marketplace add openai/codex-plugin-cc
```

```
/plugin install codex@openai-codex
```

```
/reload-plugins
```

### 4-5. 確認する(ユーザーがセッションで入力する)

```
/codex:setup
```

- Codex がインストール済みでログイン済みと表示されること。
- `/` を入力したとき、`/codex:review` などが一覧に出ること。
- `/agents` に `codex:codex-rescue` が出ること。
- デスクトップアプリの Code タブ(ローカルセッション)でも同じように出ること。

### 4-6. Codex の初期設定のモデルを決める(任意)

ユーザーにターミナルで `codex` を起動してもらい、`/model` で今のモデル名を確認する。そのうえで、`~/.codex/config.toml` に設定する(ファイルがすでにあれば、上書きせず相談する)。

```toml
model = "<`/model` に表示される Sol の名前>"
model_reasoning_effort = "medium"
```

## 5. 使い分けのルール(ユーザーと合意済みの方針)

| 作業 | 担当 |
|---|---|
| 普段の質問・調べ物・メールの下書き・アイデア出し | ChatGPT のチャット(Plus はチャットの上限がゆるいので、Claude の枠を温存できる) |
| 画像を作る | ChatGPT |
| 設計・方針決め・難しい不具合の原因探し | Claude Code(Opus) |
| 普通の実装 | Claude Code(Sonnet) |
| コードのレビュー | Codex(`/codex:review`) |
| 大量の機械的な修正・テストを回す作業・調査 | Codex(`/codex:rescue --background`) |
| Claude が5時間の上限に近づいた・達したとき | Codex に移る(`/codex:transfer`) |

### 運用のコツ
- `/usage` で Claude の残りを確認し、少なくなったら `/codex:transfer` で Codex に移る。Claude の枠が戻ったら Claude Code に戻る。
- 作業の区切りでコミットし、引き継ぎメモを残してから切り替える。
- 作業が変わったら `/clear`、会話が長くなったら `/compact` で、会話を軽く保つ。
- review gate はオフのまま。
- Codex は、簡単な作業なら Luna か Terra、普段は Sol(medium)、Astra は本当に詰まったときだけ使う。
- Claude の Fable は、Pro だと追加料金がかかるので使わない。
- 足りなくなったら、まず Claude Pro の追加購入(使用量クレジット)を検討する。毎週のように両方の上限に当たるようになったら Max を検討する。

### プラグインの主なコマンド

| コマンド | できること |
|---|---|
| `/codex:review` | 今の変更を Codex にレビューさせる(読むだけ) |
| `/codex:adversarial-review` | 設計や前提に、あえて反論させるレビュー。後ろに観点を書ける |
| `/codex:rescue` | 調査・修正・続きの作業を Codex に任せる(`--background`、`--model`、`--effort` を指定できる) |
| `/codex:status` / `/codex:result` / `/codex:cancel` | 裏で動いている作業の状況確認・結果表示・中止 |
| `/codex:transfer` | 今の Claude Code の会話を Codex に移す(表示される `codex resume <id>` で続きができる) |

## 6. 任意の作業(ユーザーに確認してから進める)

- **ルールを1つにまとめる:** Codex 用の `AGENTS.md` にルールを書き、`CLAUDE.md` には `@AGENTS.md` の1行だけを書く。こうすると Claude Code も同じルールを読む。「レビューは Codex にも頼む」などの、作業を任せるルールもここに書く。クラウドセッションで提案したが、まだ作っていない。
- **Conductor(Mac アプリ):** Claude Code と Codex を並べて同時に動かせる。ただし、同時にたくさん動かすと Claude Pro の5時間枠がすぐに尽きる。

## 7. まだ確認できていないこと

- ChatGPT Plus を契約済みか。
- ターミナル版 Claude Code があるか、あればそのバージョン。
- デスクトップアプリのプロンプト欄で `/plugin marketplace add` が使えるか(公式ドキュメントに記載がない)。

## 8. 参考リンク

- [openai/codex-plugin-cc(GitHub)](https://github.com/openai/codex-plugin-cc)
- [Install and manage plugins(Claude Code ドキュメント)](https://code.claude.com/docs/en/plugins/install)
- [Desktop application(Claude Code ドキュメント)](https://code.claude.com/docs/en/desktop)
- [Advanced setup(Claude Code ドキュメント)](https://code.claude.com/docs/en/setup)
- [Legal and compliance(Claude Code ドキュメント)](https://code.claude.com/docs/en/legal-and-compliance)
- [Configuration Reference(Codex)](https://developers.openai.com/codex/config-reference)
