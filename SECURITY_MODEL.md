# judgathon 脅威モデル

## 対象と根拠
- 対象は `github.com/kinopeee/judgathon` の Phase 0 ローカルCLI全体。この文書は仕様上の要求、実装済みの対策、未解決のリスクと運用前提を区別する。
- 現状は録画をバッチ審査する Phase 0 のローカルCLI。Webサーバー、DB、認証付きダッシュボードは実装対象外。将来のサービス構想と現在の攻撃面を区別する。
- 主な根拠: [README](https://github.com/kinopeee/judgathon/blob/af739f9341f751dd4f7a6ebc4d9c53b4baef01c9/README.md)、[仕様書](https://github.com/kinopeee/judgathon/blob/af739f9341f751dd4f7a6ebc4d9c53b4baef01c9/hackathon-ai-judge-spec.md) §22.5、§25、§40、§41、§42.5、[AGENTS.md](https://github.com/kinopeee/judgathon/blob/af739f9341f751dd4f7a6ebc4d9c53b4baef01c9/AGENTS.md)。確認したコードの基準コミットは `af739f9341f751dd4f7a6ebc4d9c53b4baef01c9`。機能や運用環境が変わった場合は、以下の前提と実装を再確認する。
- **既存仕様・利用者が確認した運用前提**と**コードからの読み取り・未確認の仮定**を以下で分ける。後者だけを理由に指摘の重大度を変更しない。
- 確認済みの運用前提: 外部から受け取った設定・実行結果も処理する。インフラリポジトリはなく、ローカルCLIとして評価する。分類はコンポーネント別のみ。

## システムとコンポーネント

| 安定した名称（Componentタグ） | 役割とコード範囲 |
|---|---|
| CLI制御 | ローカル引数、設定・Rubric・プロンプトの読込み、run/repeatの開始。 `src/cli/index.ts`、`run.ts`、`repeat.ts`、`providers.ts`、`judge-stage.ts:loadPrompt`、`scripts/judgathon.mjs`、`configs/`、`rubrics/`。 |
| メディア処理 | 録画の検証、ffprobe/ffmpeg子プロセス、音声・画像抽出と選択。 `src/media/`、`src/core/frame-selection.ts`、`src/cli/run-stages.ts:prepareMedia`。 |
| AI接続 | 外部Google Gemini生成API・Files API、認証、画像・音声送信、応答・エラーの取込み。 `src/providers/`、`src/core/retry.ts`、`src/core/usage.ts`。fixture実装もここへ分類する。 |
| 審査エンジン | 文字起こし・Evidence抽出・採点、入力データと指示の分離、参照検証、集計、レビュー判定。 `src/cli/judge-stage.ts`（プロンプト読込みを除く）、`src/cli/run-stages.ts`（prepareMedia/freezeInputsを除く）、`src/core/schemas/`、`reference-validation.ts`、`scoring.ts`、`aggregation.ts`、`name-masking.ts`、`evidence-audit.ts`、`repeat-report.ts`、`prompts/`。 |
| 成果物保管 | ローカル成果物の原子的保存、凍結入力、再審査バンドルの検証。 `src/core/storage.ts`、`src/core/input-hash.ts`、`src/cli/repeat-bundle.ts`、`src/cli/run-stages.ts:freezeInputs`。 |
| 開発・CI | 依存関係、CI、テストと開発用スクリプト。 `.github/workflows/ci.yml`、`package.json`、`pnpm-lock.yaml`、`tests/`、`fixtures/`、`scripts/`（ランチャーを除く）。 |

共有ファイルの指摘は該当関数の責務で分類する。

### データフローと信頼境界
1. 登壇者の録画 → 主催者がCLIで指定 → Node.jsからffprobe/ffmpegを呼び、ローカル音声・フレームを生成する。録画内容とメディアパーサーの境界がある。
2. live実行では環境変数の `GOOGLE_API_KEY` を使い、音声をFiles APIへ、画像やテキストを生成APIへ送る。ローカル端末と外部事業者の境界がある。fixture providerはローカル固定応答のみ。ただしメディア解析は共通処理であり、fixtureモードという指定だけではffprobe/ffmpegのネットワークアクセスを遮断しない。
3. 文字起こし・Evidence・選択画像 → Rubric/システム指示と分けてJudgeへ渡す → 応答のスキーマ・参照を検証 → 複数サンプルの採点とレビュー要求を生成する。入力コンテンツもモデル応答も信頼済み命令ではない。利用者は外部設定も処理するため、持込設定・プロンプト等を信頼された制御として採用する前にも信頼境界がある。
4. `--out` に原データ由来の成果物、応答、スナップショット、使用量等を保存する。 `repeat --from` は過去の成果物とハッシュを読み再審査する。出力ディレクトリの権限、持込バンドル、シンボリックリンク等を含むローカルFSの境界がある。
5. GitHub ActionsはPRコードと依存関係を実行する。本番配備用のTerraform/Kubernetes/Helm等は対象リポジトリ内に見つからず、利用者も関連インフラリポジトリはないと回答した。今回はローカルCLIの運用として評価する。

## 入口と到達できる主体
- **登壇者**: 音声、発話、字幕、スライド、デモ画面、動画ファイルを通じて処理に影響できる。CLIを実行する権限がなくても、主催者がその録画を処理すると到達する。
- **CLI実行者・入力ファイル提供者**: CLIパス、YAML設定、Rubric、プロンプト、pricing、fixture、過去実行バンドル。利用者は外部から受け取った設定・実行結果も処理すると確認した。その提供者が実行ユーザーと同じ権限を持つとは仮定せず、ファイルの読取り・書込み・外部送信へつながる経路を対象にする。
- **モデル／外部API**: 非決定的または不正形式の応答、APIエラー、遅延・切断。信頼せず検証する境界。
- **端末・CIへのアクセス者**: 成果物閲覧、ファイル変更、依存やPRの変更が可能な権限に応じた攻撃。ローカル書込者を一律に脅威対象外とはしない。
- 現状コードには公開HTTP受付を確認していない。インターネット上の任意の第三者から直接到達するWebエンドポイントを仮定しない。

## 保護資産
- **録画・音声・フレーム・文字起こし・Evidence**: 参加者の個人情報、未公開アイデア、デモ画面中の秘密を含み得る。公開fixtureやログへの混入、不要な第三者送信を避ける（仕様§25/§42.5）。
- **API資格情報・端末上の秘密**: キーをログやディスク、Gitへ残さない（AGENTS）。実行ユーザーのファイルが読み出し・送信される経路も対象。
- **審査の完全性と監査可能性**: スコア、根拠参照、レビュー要求、凍結入力と再実行の対応関係。参加者が指示を混入して採点を誘導するリスクは仕様§22.5で明示されている。
- **可用性・利用枠**: 主催者端末のCPU・メモリ・ディスク・実行時間とAPI使用量。重要度や許容損失額の追加指定はない。
- 特定資産を「最重要」とする追加指定はない。こちらの判断だけでcriticalへ引き上げない。

## 既存の対策と限界（コードから確認）
- メディアに拡張子・コンテナ・音声有無・最大512MiB・最大10分の検証。ffmpeg/ffprobeは引数配列で呼ぶ。これはパーサーのサンドボックスや全副処理の時間制限を保証するものではない。
- 設定とモデル出力にZodスキーマ、Evidence/Transcript/選択画像の参照検証、複数サンプル集計。
- システム指示とユーザーデータの分離、インジェクション疑いをレビュー要求へ集約。Judgeにはツール呼出し・Web検索・コード実行を提供しない（仕様§41.4、Googleアダプター）。
- fixture providerは資格情報を参照せずネットワークを使わない。CLI全体の無通信はAGENTSの要求だが、共通のffprobe/ffmpegには通信隔離がなく、実装済みの保証とは扱わない。live providerのみ環境変数からAPIキーを取得する。
- SDKリトライを無効化し、呼出しごとの120秒タイムアウトと共通試行回数上限を使う。アップロード音声はbest-effortで削除する。失敗時の削除や課金停止を絶対保証する対策ではない。
- SHA-256の凍結入力と再読込み時の整合性検証。これは署名・送信元認証ではなく、バンドル全体を書き換えられる主体に対する真正性は保証しない。
- 成果物を同一ディレクトリの一時ファイルとrenameで原子的保存する。原子的保存それ自体は暗号化、アクセス制御、パス封じ込めではない。
- 名前マスキングは審査バイアス低減用。元の文字起こし・Evidence・画像の匿名化や秘密除去を保証しない。
- CIはcontents:read、checkout時の認証情報を保持しない。配備環境の隔離・アクセス制御・保持ポリシーの実装は未確認。

## 利用者側の方針・対象外・受容リスク
- 仕様§22.5: 登壇者のTranscript/Frame/Evidenceは信頼できない。インジェクションの完全防止は目標ではなく、検出と人間レビューへの誘導を目標とする。これを検出漏れ・秘密漏洩・採点誘導の一律受容とは解釈しない。
- README/AGENTS/仕様§42.5: 現状はPhase 0ローカルCLIで、DB/サーバー等は未実装。将来機能のRole/Signed URLがないことだけを現状の公開Web脆弱性として扱わない。ただし、実在するCLI経由の漏洩・改ざんは対象。
- README: レビュー対象の採点は公式判断前に人間が元録画と根拠を確認する。fixture成功はAI品質の証明ではない。
- 同意、Providerのデータ利用条件、具体的な保持期間と公開範囲は仕様§40でも運用上の未決事項。Phase 1向けの保持例を現在のCLIで強制済みとは扱わない。
- 利用者が確認した運用前提: 外部設定・外部実行結果を入力として扱うため、それらの提供者を信頼済み主催者と同一視して降格しない。インフラリポジトリはなく、ローカルCLIを評価対象とする。個別の漏洩・改ざん・可用性リスクを受容するとの指定はない。

## 追加調査と限定検証（2026-11-03 JST、運用前提とは区別）
- 利用者が提供した別ツールの報告には、メディア解析の内部URL参照、採点へのプロンプトインジェクション、メディア処理の資源枯渇がある。これは調査資料であり、利用者が個別リスクを受容したという意味ではない。
- 調査用VM（利用者の実行環境ではない）のffprobe 4.4.2で、拡張子が.mp4のローカルDASHマニフェストを実装のvalidateMediaFileに渡すと、入力拒否前に127.0.0.1の検証専用HTTPサーバーへGETが発生した。同じ入力はプロトコル許可をfileだけにしても通信し、コンテナ形式許可も併用するとこの入力の通信は0件だった。
- 下記のHLS入力では、同じ調査用VMの現行引数でHTTP GETは0件、終了コードは1だった。stderrに `Protocol 'http' not on whitelist 'file,crypto,data'!` が記録された。このビルドと入力で観測した挙動であり、アプリケーションが許可リストを設定していることや、すべてのHLS入力で通信を遮断することの保証ではない。
- この限定検証の接続先はループバックだけ。利用者端末、内部サービス、クラウドメタデータ、応答漏洩、CLI全体の通し実行は未検証。この結果を全FFmpegビルドへ一般化しない。
- プロンプトインジェクションの採点誘導はコード上の残存リスクとして確認したが、live Geminiでの成功例は未実証。別モデルやキーワード検出を追加するだけで完全防止できるとは扱わない。
- 資源枯渇は既存スキャンのフレーム抽出指摘と重なるが、追加報告は子プロセスの期限、通常ファイル確認、全ファイル読込みも含む。ローカル環境の実際の資源限界や無期限停止の再現は未確認。

<details>
<summary>HLS限定検証の条件・入力・コマンド</summary>

- 環境: Ubuntu 22.04、ffprobe `4.4.2-0ubuntu0.22.04.1`。以下は `ffprobe -version` で確認したビルド情報。

```text
built with gcc 11 (Ubuntu 11.2.0-19ubuntu1)
configuration: --prefix=/usr --extra-version=0ubuntu0.22.04.1 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --enable-gnutls --enable-ladspa --enable-libaom --enable-libass --enable-libbluray --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libgme --enable-libgsm --enable-libjack --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-libpulse --enable-librabbitmq --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libsrt --enable-libssh --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-lv2 --enable-omx --enable-openal --enable-opencl --enable-opengl --enable-sdl2 --enable-pocketsphinx --enable-librsvg --enable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-libx264 --enable-shared
```

- 入力: 次のテキストを `hls.mp4` として保存した。HTTPサーバーは `127.0.0.1` のみにbindし、OSが割り当てたポート（この実行では42721）でGETを記録し、HTTP 200とダミー本文 `not-a-video`（11バイト）を返す。外部サービスや秘密情報は使用しない。

```text
#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:1.0,
http://127.0.0.1:42721/segment.ts
#EXT-X-ENDLIST
```

- 呼出し: 入力パスだけを相対表記に置換した完全な引数列。アプリケーションと同様に明示的な許可リストは指定していない。検証ハーネス側で4秒の期限を設定したが、CLIに実装された期限ではない。

```sh
ffprobe -v error -show_entries format=format_name,duration:stream=codec_type,width,height -of json ./hls.mp4
```

- 対照確認: 上記に `-protocol_whitelist file,http,tcp` を入力前のオプションとして追加すると、同じサーバーへのGETが1件記録された。ダミー本文はメディアではないため、この場合も解析は失敗した。解析失敗だけを無通信の証拠にせず、GET記録で区別する。

</details>

## 未確認事項
- 実際の端末・CIでの共有権限、外部入力を受け取る具体的な手順、録画同意・保持とAPI送信の運用。
- 追加の重要資産や個別の受容リスク。未指定のため、スキャナーの重大度を基準とする。

## 指摘の優先度と分類
- スキャナーが検証した成立条件・悪用難度・影響の評価を基準にする。上記の利用者側方針、または今後の回答が該当するときだけ優先度を変える。
- 未回答の仮定やこちらのコード読解だけで降格しない。悪用困難・未検証とされた指摘は引き上げない。変更時はその根拠、成立条件と影響の双方を短く記録する。
- `Component` は上表の名称。利用者の回答に従い、コンポーネント別のみで分類する。
- この文書はリスク評価の前提であり、個別指摘の成立・不成立や修正完了を保証するものではない。

## 更新の契機
- Web受付・共有ワーカー・公式判断の自動化など、現在の信頼境界や出力の用途が変わる場合。
- 外部設定・実行結果の受入手順、重要資産、権限、保持・公開範囲、受容するリスクが変わる場合。
- メディアツールのビルド、通信隔離、資源制限、Provider、検証・レビュー方式を変更する場合。対策の追加は実装と検証を確認してから反映する。
