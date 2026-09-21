# AGENTS.md

このファイルは、このリポジトリで作業する AI エージェント / 開発者向けの共通ガイドです。

## プロジェクト概要

- 目的: ハッカソンのピッチ録画をバッチ処理で AI 審査する CLI パイプライン（Phase 0 PoC）
- 仕様の正本: `hackathon-ai-judge-spec.md` v0.4（§41 implementation contract）。挙動の判断は diff ではなく仕様書に照らす
- レビュー観点: `REVIEW.md` を参照（本ファイルとは重複させない）
- 使い方・終了コード・出力レイアウト: `README.md` を参照

## 採用技術スタック（確定）

- 言語: TypeScript（ESM、`module: NodeNext`）
- 実行環境: Node.js 22 以上 / pnpm 10（`packageManager: pnpm@10.34.5`）
- バリデーション: Zod 4（`src/core/schemas/`）
- LLM provider: `@google/genai`（Gemini、live モードのみ）
- メディア処理: `ffmpeg` / `ffprobe`（PATH 必須）
- テスト: Vitest / Lint: ESLint 9（flat config）

## まず確認すること

1. `README.md` と `hackathon-ai-judge-spec.md` の該当セクションを読む
2. `pnpm install --frozen-lockfile` → `pnpm build` が通るか確認する
3. 変更対象が artifact 形式・ハッシュ・終了コード・provider 境界に触れるか確認する（下記「壊してはいけない不変条件」）
4. `prompts/` `rubrics/` `configs/` の変更は内容変更＝ `input_hash` を変える意味的変更と認識する

## ディレクトリ構成と責務

- `src/cli/` — `run` / `repeat` サブコマンドの入口と引数処理
- `src/core/` — パイプライン本体（storage / input-hash / scoring / aggregation / usage / errors / schemas）
- `src/core/schemas/` — Zod スキーマ（外部入力は必ずここ経由で検証）
- `src/media/` — ffmpeg / ffprobe / フレーム選択（phash）
- `src/providers/` — provider 抽象（`types.ts`）、`fixture/`（ネットワーク・認証なし）、`google/`（live）
- `prompts/` `rubrics/` `configs/` — バージョン管理された入力コンテンツ（ハッシュ対象）
- `fixtures/` — fixture モード用の固定 provider 応答（`tr#0` / `frame#2` / `ev#1` プレースホルダ）
- `tests/` — Vitest テスト
- `scripts/` — `judgathon.mjs`（ランチャー）、`make-sample-video.mjs`（開発用）

## 壊してはいけない不変条件

- **Frozen inputs**: `frozen_inputs.hash_version: 2`。`input_hash` は transcript / evidence-set / config・rubric snapshot / 選択フレーム（順序込み）/ 全プロンプトハッシュ / judge スキーマハッシュを含む。ハッシュやシリアライズの変更は破壊的変更であり、PR で明示する
- **Artifact 形式**: 永続化 JSON はすべて snake_case、`schema_version` 付き、`writeJsonAtomic` / `writeTextAtomic`（tmp + rename）による原子書き込み。artifact JSON の直接 `fs.writeFile` は禁止
- **終了コード**: 成功は `0`、CLI 失敗は `CliError` 経由で `2/3/4/5`（`src/core/errors.ts`）。ad-hoc な `process.exit` や README 未記載の新コードは禁止
- **fixture モード**: ネットワークアクセスも credential 参照も行わない
- **live モード**: `GOOGLE_API_KEY` をディスク・ログに書かない。SDK リトライ無効（`attempts=1`）・120 s タイムアウトを維持
- **Usage 集計**: `calculation_version: gemini-output-plus-thinking-v2`。必須トークン数が不明なら推定コストは `null`（部分推定しない）
- **`asr_confidence`**: v2 パイプラインでは意図的に `null`。バグではない
- **品質閾値**: `repeat` の σ ≤ 0.5、`needs_review` / `injection_suspected` の意味論は仕様書由来。仕様更新なしに変えない

## 実装方針

- 最小差分で変更し、仕様書にない大きな機能は追加しない
- 外部入力は `unknown` で受けて既存の Zod スキーマで検証する
- `any` を使わない（`unknown` + 型ガード）
- provider 向け出力は `ProviderCallResult<T>` 経由で raw text / usage / latency を維持する
- fixture モードの成功はパイプライン機構の検証であり、AI 品質の根拠にしない

## Phase 0 の対象外（non-goals）

- DB / サーバー、OpenAI provider（`CONFIG_INVALID` として拒否）、Q&A 編集、ライブキャプチャ
- fixture 実行からの AI 品質主張

## セキュリティ・運用

- API キー・秘密情報は環境変数で管理し、コミット・ログ出力しない
- `.env*`、`out/`、`live-runs/`、生成メディア（`samples/*.mp4` / `*.webm` / `samples/**/media/` / `*.wav`）はコミットしない（`.gitignore` 済み）

## テストと検証

最低限確認するコマンド（CI と同一）:

```bash
pnpm install --frozen-lockfile
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint .
pnpm build       # tsc -p tsconfig.build.json
pnpm test:coverage  # vitest run --coverage（CI と同一）
```

手動確認の目安（fixture モード、ネットワーク不要）:

```bash
node scripts/make-sample-video.mjs samples/team_alpha.mp4
pnpm exec judgathon run --video ./samples/team_alpha.mp4 \
  --rubric ./rubrics/hackathon-2026-v3.yaml \
  --config ./configs/judge-google-v4.yaml \
  --output-language ja --provider-mode fixture --out ./out/team_alpha
pnpm exec judgathon repeat --from ./out/team_alpha --times 5 \
  --provider-mode fixture --out ./out/team_alpha_repeat
```

## 変更時チェックリスト

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm test:coverage` が通る
- [ ] 不変条件（hash、artifact 形式、終了コード、provider 境界）を壊していない
- [ ] ハッシュ・シリアライズ変更がある場合、破壊的変更として PR に明記した
- [ ] 秘密情報をコミット・ログ出力していない
- [ ] 仕様書と整合しない挙動変更は `hackathon-ai-judge-spec.md` の更新とセットにした

## コミットメッセージ規約

Conventional Commits 準拠。日本語で記述（既存履歴に倣う）。

```text
<prefix>: <サマリ（50文字以内）>

- 変更内容1
- 変更内容2
```

## PR メッセージ規約

コミットメッセージ規約と整合。日本語で記述。

```markdown
## 概要

この PR で実装・修正した内容の要約

## 変更内容

- 変更点 1
- 変更点 2

## テスト内容

- 実施したテスト・確認内容
```
