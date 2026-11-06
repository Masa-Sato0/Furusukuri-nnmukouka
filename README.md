# Fullscreen Web Search

許可したWebサイトで、Fullscreen APIによる全画面表示を維持しながらBrave Searchを使うChrome拡張機能です。Manifest V3、JavaScript / HTML / CSSで実装し、実行時の外部フレームワーク・CDN・リモートコードはありません。

検索結果はページ内の右側パネルに表示します。検索結果のリンクを開くときだけ別タブを使用します。リンク先ページ自体をパネルに埋め込む機能はありません。

**検証状況：単体テスト24件、実ChromiumのDOM・Fullscreen操作テスト25項目が成功しました。Chrome runtime / API応答は模擬です。実際の拡張機能の読み込みは開発環境の管理ポリシーで禁止されているため、Brave実API通信・ChromeOS実機とともに未確認です。** 詳細は [TEST_RESULTS.md](TEST_RESULTS.md) を参照してください。

## ファイル構成

```text
.
├── manifest.json           # MV3・コマンド・必須/任意権限
├── background.js           # 許可確認、動的登録、フレーム選択、Brave通信
├── shared.js               # URL・クエリ・API応答検証
├── content.js              # ISOLATED worldのUI・Fullscreen・DOM管理
├── styles.css              # Shadow DOM内のパネルCSS
├── options.html
├── options.js              # APIキー・許可サイト・ショートカット設定
├── settings.css
├── popup.html
├── popup.js                # 開閉・動作できない理由の表示
├── README.md
├── TEST_RESULTS.md
├── package.json            # 開発用。使用時にnpmは不要
└── tests/
    ├── unit.test.cjs
    ├── e2e.cjs              # 実ブラウザ、テスト用の模擬runtime
    ├── extension-smoke.cjs  # 実MV3 Service Workerの読み込み確認
    ├── server.cjs
    ├── test-page.html
    ├── test-page.js
    ├── test-page.css
    ├── second.html
    ├── frame.html
    └── frame.js
```

## ChromeOS / Chromebookへのインストール

1. このリポジトリの「Code」→「Download ZIP」で取得し、展開します。git cloneでも構いません。
2. Chrome 120以降で `chrome://extensions` を開きます。
3. 右上の「デベロッパー モード」をオンにします。これは**拡張機能画面の設定**です。ChromeOS本体のデベロッパーモードやLinux環境は、拡張機能を使うためには不要です。
4. 「パッケージ化されていない拡張機能を読み込む」で、展開した `Furusukuri-nnmukouka-main` などの **manifest.jsonが直接入っているフォルダー**を選びます。
5. 拡張機能メニューからピン留めし、「Fullscreen Web Search」→「設定」を開きます。
6. 利用が認められたサイトURLを入力して「サイトを許可」を押し、Chromeの権限確認を承認します。初期状態では一つも許可していません。
7. Brave APIキーを保存し、対象ページで `Ctrl+Shift+Y` を押します。

管理対象のChromebookで読み込みやサイトアクセスが禁止されている場合は、管理者に確認してください。制限を変更・回避する機能は実装していません。

許可追加は開いているページにも適用します。接続できない場合は、そのページを再読み込みしてください。拡張機能を更新した場合も、拡張機能と対象ページの両方を再読み込みしてください。

## Brave Search APIの設定

1. [Brave APIダッシュボード](https://api-dashboard.search.brave.com/)で登録します。
2. Web Searchエンドポイントを利用できるプランを選び、APIキーを発行します。料金・レート制限は契約内容を確認してください。
3. この拡張機能の「設定」→「Brave Search API」にキーを貼り付け、「キーを保存」を押します。
4. 許可したサイトでパネルを開き、日本語の検索語を入力してEnterを押します。

キーは `chrome.storage.local` に保存し、Chrome同期は使いません。保存済みキーを入力欄に再表示せず、ソース・ログ・コンテンツスクリプトへの応答に含めません。`storage.local.setAccessLevel(TRUSTED_CONTEXTS)` でコンテンツスクリプトからの読み出しを制限します。ただしローカルストレージは暗号化保管庫ではなく、端末の利用者や開発者ツールから完全に秘匿できる仕組みではありません。

Service Workerから固定エンドポイントに通信します。

```text
https://api.search.brave.com/res/v1/web/search
q=<検索語>&count=10&offset=<0〜9>&search_lang=jp&ui_lang=ja-JP&country=JP
```

`offset` はページインデックスです。1回最大10件、`more_results_available` に従って最大10ページまで移動します。無効なURLを除外した場合は10件未満です。Google検索結果との同一性はありません。

キー未設定、401 / 403、429、その他HTTPエラー、通信失敗、不正JSON・応答形式を処理します。タイムアウトは15秒です。429では `Retry-After` を1〜3600秒の範囲で尊重し、指定がない場合は30秒間再検索を抑制します。自動再試行はありません。待機時間はメモリー内のため、Service Worker再起動でリセットされ、再度429なら待機を設定します。

検索語・結果はパネル表示中のメモリーだけで扱い、履歴として保存しません。閉じると削除します。Brave側の取り扱いはBraveの規約・契約に従います。

### 商用公開する場合

共通の有料APIキーを拡張機能に埋め込まないでください。利用者認証を備えたHTTPSバックエンドプロキシを推奨します。サーバー側でBraveキーを保管し、ユーザー別のレート制限・利用枠・課金上限・入力検証・タイムアウト・悪用対策を実装します。キーと検索語をログに記録しない設定を標準とし、記録が必要なら保持期間と目的を説明します。通信先とホスト権限を固定し、再配布・キャッシュ・表示条件を契約で確認します。この納品版はユーザー自身のキーによる直接API方式です。

## 操作

- `Ctrl+Shift+Y`：パネルを開閉。開いた際は入力欄にフォーカス。
- Enter：検索。次へ / 前へ：ページ送り。
- 閉じるボタン：パネルのみを閉じます。`exitFullscreen()` は呼びません。
- Escape：ページがキーを受け取れる場合にパネルを閉じます。IME変換中は奪いません。
- Tab / Shift+Tab：パネル内を移動。
- 「URLをコピー」：Clipboard APIを試し、利用できない場合は選択可能なURL欄にフォールバックします。自動コピーが禁止されている場合はCtrl+Cを使用します。
- リンク：`noopener noreferrer` を付けて別タブで開きます。全画面が解除される可能性をUIに明示しています。

EscapeはChromeの全画面解除にも使われます。ブラウザが先に処理する環境では解除を防げません。全画面維持を優先する場合は閉じるボタンか拡張機能のショートカットを使用してください。設定画面への移動でも全画面が解除される可能性があります。

割り当て変更は設定画面のボタン、または `chrome://extensions/shortcuts` から行います。競合で未割り当ての場合も変更できます。ChromeOSのSearch / Launcherキーやシステムショートカットの優先順位は実機で確認してください。

## Fullscreen / DOMの設計

1. `document.fullscreenElement` を調べ、open Shadow DOM内の `shadowRoot.fullscreenElement` があれば実際の要素までたどります。
2. Fullscreen API中はその要素の子要素にホストを追加し、通常表示とブラウザ自体の全画面表示では `document.body` に配置します。
3. ホストのShadow DOMにUIとスタイルを作り、ホスト自身の配置はinline `!important` で指定します。
4. `popover="manual"` と `showPopover()` でトップレイヤーへ表示します。全画面要素とのDOM上の親子関係を維持し、通常のz-index・transform・overflow競合に対応します。
5. `fullscreenchange` で配置先を更新します。サイトのJavaScript、Fullscreen API、History APIは上書きしません。
6. パネルが開いている間だけMutationObserverでDOM置換・削除を監視し、open Shadow DOMの対象ルートも監視します。配置処理をマイクロタスクでまとめ、常時ポーリングは使いません。
7. ホストが繰り返し削除される場合、2秒間に8回の配置で中止し、ページと無制限に競合しません。
8. 再注入は単一インスタンスで処理します。通常遷移は動的に登録したdocument_startスクリプトで再初期化します。SPAは `webNavigation.onHistoryStateUpdated` / `onReferenceFragmentUpdated`、popstate / hashchangeで検出します。URL変更時は旧パネルを閉じ、次の操作で再表示します。
9. 閉じるとObserverを切断し、進行中リクエストを中断します。許可解除ではリスナーとインスタンスを破棄し、古い応答を新しい検索へ描画しません。

幅480px、狭い画面では100vwです。ページ全体を覆う背景やスクロールロックはありません。パネル内の通常のバブリングイベントはページへ伝えませんが、サイトのcaptureリスナーを隠す・無効化する機能はありません。

## iframe・既知の制限

トップページと、実際にFullscreen APIを呼ぶ子フレームの両方を許可してください。動的スクリプトは `allFrames: true` ですが、許可パターンとChrome権限を満たすhttp / httpsドキュメントだけが対象です。全画面中は最も深い全画面フレームを選び、通常表示ではトップページに表示します。

別オリジンのDOMを直接読みません。`webNavigation.getAllFrames` とChromeのフレーム指定メッセージで連携します。iframeの `allow="fullscreen"`、Permissions Policy、sandbox、サイト・管理者ポリシーによっては利用できません。

以下は非対応、または実環境で追加確認が必要です。

- video / canvas / img等の置換要素自体の全画面。サイトにHTMLコンテナーを全画面化する操作があれば、その操作を使ってください。拡張機能はサイトの処理を変更しません。
- iframe要素自体だけが全画面で、許可された子ドキュメントにFullscreen APIの要素がない場合。
- 未許可フレーム、opaque originのsandbox、about:blank / srcdoc / data:フレーム。`match_origin_as_fallback` による権限拡大は行いません。
- closed Shadow DOM内部の全画面要素に到達できない場合。描画寸法・入力フォーカスを得られない場合は中止します。
- inertな祖先、サイトによる繰り返し削除、後から開くモーダル等のトップレイヤーUI。
- chrome://、Chrome Web Store、PDFビューアー等の制限ページ、管理ポリシーで禁止された拡張機能・サイトアクセス。

表示できない理由は、拡張機能アイコンの `!` バッジとポップアップに表示します。ブラウザ自体の全画面表示では `document.fullscreenElement === null` であり、Fullscreen APIの状態と区別します。ブラウザ・サイトの制限を突破する処理はありません。

## 権限・セキュリティ

| 権限 | 用途 |
| --- | --- |
| storage | APIキー・許可サイト、セッション内の診断理由 |
| scripting | 許可したサイトだけにISOLATED / document_startのスクリプトを登録・注入 |
| webNavigation | SPAのHistory API遷移検知、全画面iframeの一覧取得 |
| https://api.search.brave.com/* | Service WorkerからBrave Search APIへ通信 |
| 任意のhttp://*/*・https://*/* | 宣言範囲。実際の要求はユーザーが指定したスキーム・ホストだけ |

tabs、activeTab、clipboardRead、clipboardWrite、notificationsは要求しません。Chromeのマッチパターンはポートを限定できないため、同じスキーム・ホストの全ポート・全パスが対象です。サブドメインとhttp / httpsは別々に許可します。

検索結果は `textContent` とDOM APIで描画し、HTMLを解析・実行しません。リンクはhttp / httpsに限定し、認証情報付きURLを拒否します。API通信先は固定し、リダイレクトを拒否します。`credentials: 'omit'`、`referrerPolicy: 'no-referrer'` を指定し、サイトのCookie・認証情報・参照URLを送りません。APIキーやエラーレスポンスの本文をログに出しません。

Shadow DOMはスタイル分離であり、秘密保持の境界ではありません。ページ内の検索語・結果はサイトから観測される可能性があります。監視やアクセス制限の隠蔽は実装していません。

## ローカルでの動作確認

Node.js 20以降で実行します。拡張機能の利用自体にはNode.jsは不要です。

```sh
cd Furusukuri-nnmukouka
npm run test:serve
```

ChromeOSではLinux開発環境、または同一ネットワーク内の開発PCを使用できます。サーバーがChromebookから見えることを確認してください。

1. 設定で `http://localhost:8787` を許可し、別ホストiframeも試すなら `http://127.0.0.1:8787` を許可します。
2. `http://localhost:8787/` を開き、通常表示で日本語検索・コピー・ページ送りを確認します。
3. 「コンテナーを全画面表示」を押し、ショートカットでパネルを開きます。
4. 閉じるボタンとショートカットの両方で、閉じた後も全画面が維持されることを確認します。
5. DOM再生成、open Shadow DOM、通常遷移、SPA遷移、再読み込みを確認します。
6. キー未設定・無効キーの案内を確認し、正しいキーへ戻して復旧を確認します。429確認のために実APIへ大量通信せず、模擬テストを使用してください。
7. iframeで全画面表示し、子サイトの許可を外した場合は理由が表示されることを確認します。
8. ChromeOSで割り当て・競合を確認し、TEST_RESULTS.mdの手動確認表を埋めます。

### 自動テスト

```sh
npm install
npx playwright install chromium
npm test
npm run test:e2e
npm run test:extension
```

`test:e2e` は `/usr/bin/chromium` を標準とします。他の環境では実行ファイルを指定してください。

```sh
CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

`test:extension` はPlaywrightのChromiumを標準とし、同じ変数で変更できます。実際に拡張機能を読み込み、Service Worker起動・コマンド定義を確認します。管理ポリシーで禁止されている場合は失敗を報告し、ポリシーは変更しません。成功しても実API・実ショートカット・ChromeOS実機の確認の代わりにはなりません。

`test:e2e` は実ブラウザのISOLATED worldに、テスト内だけのChrome runtime模擬実装を入れます。DOM、Shadow DOM、Fullscreen API、フォーカスは実ブラウザですが、Chromeの自動注入、権限、Service Worker通信、API通信、commandsイベントは実物ではありません。通常遷移・再読み込みではテスト側がコードを注入し、SPAでは遷移メッセージを送っています。テスト用コードは拡張機能の実行ファイルから参照しません。
