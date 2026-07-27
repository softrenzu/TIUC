# クビアカツヤカミキリ 通報アプリ

サクラ・ウメ・モモなどバラ科樹木の害虫「クビアカツヤカミキリ」の被害を、
市民がスマホで撮影・通報し、行政の防除につなげる市民参加型アプリ。
被害の痕跡である「フラス」(幼虫が幹から押し出す木くず状の排出物)の写真と
位置情報を集め、地図で可視化する。

## 技術スタック

- **全面的に Cloudflare 無料枠**で構築・運用する(Vercel/Supabase は不採用)。
  Cloudflare の無料プランには非商用制限がなく、自治体連携時にも規約問題が出ないため。
- Worker (`src/index.js`) が API と静的配信を兼ねる。フレームワークは未使用(素の Worker)。
- フロントは `public/` 配下の素の HTML + ES モジュール。ビルド工程なし。
  - `public/index.html` … トップページ = キャラ育成ゲーム(仮称「ヨソモン」)。全員が最初に
    通るページで、通報・トリアージ投票は「キャラを育てるアクション」として導線を張る
  - `public/menu.html` … 通報/マップ/マイページへの導線をまとめた実務ページ(旧トップページ)。
    `index.html`から「☰ メニュー」で遷移
  - `public/report.html` … 通報フォーム
  - `public/map.html` … 公開マップ
  - `public/mypage.html` … 通報者マイページ
  - `public/review.html` … レビュー画面(行政職員によるオフィシャル判定。ゲームのプレイヤー
    には含めない、完全に別系統の役割)
  - `public/mesh.js` … JIS X 0410 地域メッシュコード算出(クライアントとWorkerで**共有**)
  - `public/exif.js` … 依存ライブラリなしのEXIF解析
- **D1** (SQLite) … データベース。バインディング名 `DB`、DB名 `kubiaka-db`
- **R2** … 画像ストレージ。バインディング名 `PHOTOS`、バケット名 `kubiaka-photos`
- 地図(未実装)は **MapLibre GL JS(CDN)+ 国土地理院タイル**を予定。Google Maps は使わない。

## 開発環境

- macOS / Node は **nvm で v22**(wrangler が v22 以上を要求。v20 は EOL)。
- ローカル: `npx wrangler dev` → http://localhost:8787
- ローカル D1: `npx wrangler d1 migrations apply kubiaka-db --local`
- **本番へのデプロイは git push で自動**(Cloudflare Workers Builds が GitHub 連携で実行)。
  `wrangler deploy` を手打ちしない(二重デプロイになる)。

## 絶対に守る設計ルール

1. **座標の出し分け(最重要)**
   - DB には正確な緯度経度を1つだけ持つ。出口で粒度を変える。
   - 一般公開 API は座標を返さない。250m/1km メッシュ集計のみ。
   - 正確なピンを出してよいのは `land_type='public' AND status='confirmed'` の案件のみ
     (街路樹・公園など公有地。私有地の庭木・果樹園は近隣トラブル・風評リスクのため出さない)。
   - 自治体アカウントのみ全件の正確な座標を閲覧可。閲覧は `coord_access_log` に必ず記録。
   - `/img/` 配下の画像配信はレビュアー認証必須(私有地の写真のため)。例外は2つ:
     (1) 通報者本人が自分の投稿を `/api/mypage` の一覧からタップして見る場合
     (`?reporter_id=` が該当 report の reporter_id と一致する時のみ)。
     image_key/thumb_key 自体に推測不能な通報IDが埋め込まれているため、この例外は
     `/api/mypage` が元々持つ露出面(reporter_id を知っていれば履歴が見える)を
     広げない。
     (2) キャラ育成ゲームの匿名投票者(`?voter_id=`)。**`thumb_key` のみ**に限定し
     `image_key`(フル解像度)には絶対にマッチさせない。対象は未レビュー
     (`pending_review`/`provisional`)かつ自分の投稿でなく未投票の場合のみ。

2. **メッシュコードはサーバ側で必ず再計算する。**
   クライアントが送ってきたメッシュ値は信用しない(偽座標での新規メッシュボーナス稼ぎを防ぐ)。
   計算式は `public/mesh.js` に一元化。式を2箇所に複製しないこと。

3. **ゲーミフィケーションは水増しを構造で防ぐ。**
   - 投稿時は小さく(1点、異常なし報告は2点)、専門家の確定時に大きく(被害あり10点、異常なし確定3点)。
   - 誤報確定で投稿時の点を取り消し(`point_events` に revoke を追加)。
   - ポイントは**合計値ではなく台帳** (`point_events`) で持つ。`reporters.points_total` は集計キャッシュ。
   - 個人ランキングより地域チーム戦。
   - 「見たが異常なし」も正式なデータ(不在データ)。ただし写真は必須(机上でのポイント稼ぎ防止)。
   - `trust_score` は確定率のラプラス平滑化。レビュー優先度と表示順に反映。
   - キャラ育成ゲーム(仮称「ヨソモン」、`index.html`)のXP(通報送信・トリアージ投票の
     どちらでも貯まる)は、この経済と完全に分離した別台帳(`xp_events`/`characters`)で持つ。
     「投稿の正確性」に紐づく既存ポイントの意味を、育成要素と混ぜて壊さないため。

4. **AI 判定は種の同定をさせない。**
   「幹が写っているか」「木くず状のものがあるか」「明らかに無関係か」の足切りのみ。
   クビアカ固有の判定は人間(レビュー画面)が行う。人間レビューは残しており、`ai_verdict`/
   `ai_raw`(neuron使用量込みの生ログ)を`reports`に保存して精度を実測できるようにしてある。
   Workers AI(`@cf/meta/llama-3.2-11b-vision-instruct`)を通報受付と同期的に呼び出す。
   実測コストは1件あたり約9〜10neuronで、無料枠(1日1万ニューロン)でも十分な余裕がある
   (当初「vision で1日数百件が上限」と見積もっていたより実際はかなり軽い)。

5. **コメント機能は自治体からの一方向のみ**(`response_note`)。
   住民間の自由コメントは「〇〇さんの家が放置」型の書き込みを生むため実装しない。

6. **スタンプは2種のみ**(`reactions` テーブル)。`seen_too`(私も見た)/ `thanks`(ありがとう)。
   複合主キーで連打を DB が弾く。

7. **書き込み順序**: 通報時は R2(画像)を先、D1 を後。逆にすると「行はあるが画像がない」状態が
   レビュー画面を壊す。孤児オブジェクトが残る方が後始末が楽。
   D1 の複数更新は `batch()`(暗黙トランザクション)でまとめる。

8. **秘密の値**は `.dev.vars`(ローカル、gitignore 済み)と Cloudflare ダッシュボードの
   Secret(本番)で管理。`wrangler.jsonc` に書かない(git に載るため)。

## スキーマ

`migrations/` にファイルで管理する(D1 Console への手貼りは禁止。ローカルと本番がズレる原因)。
主要テーブル: `reports`(通報本体), `reporters`(通報者/匿名UUID), `reviewers`,
`point_events`(ポイント台帳), `survey_mesh`(調査対象メッシュ/未調査エリア可視化用),
`reactions`(スタンプ), `coord_access_log`(座標閲覧監査), `teams`(地域チーム),
`triage_votes`(キャラ育成ゲームの匿名クラウド判定投票), `characters`(育成中のキャラ状態),
`xp_events`(トリアージ投票のXP台帳。`point_events`とは完全に別経済 — rule3参照)。
公開用ビュー `public_mesh_stats` は構造的に座標を含まない。

reports.status: queued / auto_rejected / pending_review / provisional /
                confirmed / rejected / duplicate
  ※AI一次判定は通報受付と同じリクエスト内で同期的に完結するため(`queued`は永続化されず、
    判定結果の`auto_rejected`/`provisional`/`pending_review`のいずれかで直接INSERTされる)、
    DB上に`queued`状態の行が存在することは実質無い。
reports.land_type: public / private / unknown(レビュー時に自治体が入力)
reports.response_status: null / scheduled / treating / done(現地の対応状況。status とは別概念)

## 認証(暫定)

レビュー画面は Worker 内の簡易認証(共有パスワード + HMAC 署名 Cookie + レビュアー名の自己申告)。
**本番運用前に Cloudflare Access へ移す**。ただし Access は独自ドメインが必要で workers.dev には
掛けられない。自治体連携が具体化したらドメイン取得(年約1,500円)→ Access へ移行。

通報者(市民)側は**Googleログインが任意**で使える(`GET /api/auth/google/start`〜
`/callback`、`GET /api/auth/me`、`GET /api/auth/logout`)。ゲスト(匿名UUID)運用は完全に維持しており、
ログインで変わるのは「端末をまたいで同じ通報者に戻れる」ことだけ(不正対策・レート制限には関与しない)。
Cookie名`uid`・秘密鍵`env.AUTH_SECRET`はレビュアー用の`rv`/`REVIEW_SECRET`とは完全に別(信頼レベルが違うため共用しない)。
既知の制約: 実データを持つ複数のゲスト端末を後から同じGoogleアカウントに統合(マージ)する機能は無い
(先にログインした端末の履歴が残り、別端末の履歴は表示されなくなる)。

## 現在地(2026-07 時点)

完了: 通報フォーム(地図タップでの位置指定フォールバック込み) / 通報受付 API / R2保存 / D1登録 /
      レビュー画面(判定・土地種別・対応状況・お知らせ) / 公開マップ(MapLibre + 国土地理院タイル
      「標準地図」、`GET /api/map`、mesh3/mesh4/mesh5の3段階ズーム対応、未調査エリアの目安表示※、
      徒歩スケールの確認済みエリア円表示、Googleマップ経路検索連携、凡例・詳細検索は上部バーの
      アイコンから開閉するドロップダウンに統合(スマホでの地図隠れ対策)、エリア名検索(国土地理院
      住所検索API)は常時入力できる別枠として上部バーに常設、メッシュ集計の配色は赤系5段階) /
      スタンプ(seen_too・thanks、`POST /api/reactions`、通報フォームでの近隣重複確認
      `GET /api/nearby` 込み) / 通報者マイページ(`GET /api/mypage`、通報カードタップで
      写真込みの詳細表示。写真は本人の`reporter_id`一致時のみ`/img/`を許可する例外ルート経由。
      未レビュー(`queued`/`auto_rejected`/`pending_review`/`provisional`)の通報のみ、
      本人による削除(`POST /api/reports/delete`)・軽い修正(発見物・樹種・メモのみ、
      `POST /api/reports/edit`)が可能。削除時はポイント台帳も遡って取り消し、R2画像も削除) /
      通報フォーム送信後の完了ポップアップ(マップ/マイページ/トップへの導線) /
      ランディングページ(`/`、通報・マップをスクエアの主要導線(緑・青)、マイページは
      控えめな横長導線の2カラムUI) / 通報者向けGoogleログイン(任意、ゲスト併存) /
      AI一次判定(Workers AI、`@cf/meta/llama-3.2-11b-vision-instruct`、通報の`thumb`に対して
      「幹が写っているか」「木くず状のものがあるか」「明らかに無関係か」の3項目のみをJSONで
      判定。種の同定はさせない。`clearly_irrelevant`なら`auto_rejected`(ポイント不付与)、
      幹か木くずのどちらか検出なら`provisional`(地図に暫定表示、人の確認待ち)、それ以外は
      `pending_review`。AI呼び出しの失敗・タイムアウト(15秒)・パース不能はすべて
      `pending_review`にfail-open。実測コストは1件あたり約9〜10neuron(無料枠1万/日で
      余裕をもって数百〜千件程度)。`auto_rejected`時は通報フォームにポップアップで
      「撮り直す」(該当行を削除して再送信可能な状態に戻す)/「このまま送信する」
      (`POST /api/reports/force_review`で`pending_review`へ上書き、ポイントも通常通り付与)
      の2択を提示。AIの足切りは最終判断ではなく人間レビューが常に上位、という設計をUIとして
      具体化したもの。上書きされた行は`ai_verdict='reject'`のまま残るので、レビュー画面に
      「AI却下→本人が送信」のアラートバッジが出る) /
      キャラ育成ゲーム(仮称「ヨソモン」)が`index.html`(トップページ)そのものになった。
      通報(`report.html`、`+5XP`)・トリアージ投票(下記、`+2XP`)がキャラを育てるアクションと
      して導線の主役。旧トップページの内容(通報/マップ/マイページのタイル)は`menu.html`に
      退避し、`index.html`から「☰ メニュー」で遷移する形に変更。トリアージ投票は、通報された
      写真(未レビュー・`pending_review`/`provisional`のみ)を匿名の他ユーザーがサムネイル
      だけ見て「木っぽい/証拠あり/無関係」の3択で投票する匿名クラウド判定(`GET
      /api/triage/next`、`POST /api/triage/vote`)。位置情報・メモ・通報者情報は一切見せない。
      最終判定権限は今まで通りレビュアー(行政職員)のみが持ち、ゲームのプレイヤーには
      一切含めない(`review.html`は完全に別系統のまま)。進化・バトル等のゲーム的な広がりは
      未定のため今回は対象外。キャラのビジュアルは絵文字による暫定表現。
      レベルカーブは序盤(〜Lv8)が1レベル2〜3XPで速く(目安10コミットでLv8)、Lv8〜10で
      4〜5XPとやや重くなり(目安15コミットでLv10)、以降も3レベルごとに+1XPずつ緩やかに
      難度が上がり続ける天井なし設計(`xpCostForLevel`/`xpForLevel`/`xpToLevel`、
      `src/index.js`)。`characters.level`列はSQL上の参考値でしかなく、表示・判定は常に
      `xp_total`からJS側で再計算する(`reporters.points_total`と同じ「集計キャッシュ」の
      位置づけ)。レベルアップ時は`index.html`に専用モーダルを表示し、絵文字のビジュアルが
      変わる節目(Lv3・Lv6・Lv10)では「進化した!」の特別演出になる。
未着手: チーム機能 / Cloudflare Access 移行 / 独自ドメイン / キャラ育成ゲームの進化・バトル要素
        (仕様未定)。

※ 未調査エリア表示は `survey_mesh`(自治体の調査対象データ)未整備のため、「bboxを現在のズーム粒度
  (mesh3/4/5)のグリッドで理論上列挙し、通報が1件も無いセル」を暫定的な代用指標として使っている
  (`public/mesh.js` の `meshGrid`/`meshGridCount`、`map.html` 内で完結、新規APIなし)。山林・水面など
  本来調査対象外のエリアも区別なく「未調査」表示になる既知の制約あり。自治体側の実データが手に入ったら
  `survey_mesh` テーブルを使う本来の設計に置き換える。
  この未調査判定は250m(mesh5)より細かくしない — 通報の存在有無を250mより細かい粒度で開示することは
  ルール1(一般公開は250m/1kmメッシュ集計まで)と実質的に矛盾するため。徒歩スケールの体験は、
  既に正確な座標が公開済みの公有地確定ピンの周辺だけに「確認済み」円を重ねる形で補っている
  (ピンは元々exactな座標なので、これは新たな情報開示にはならない)。
