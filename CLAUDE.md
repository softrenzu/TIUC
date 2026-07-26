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
  - `public/index.html` … ランディングページ(通報する/マップ/マイページへの導線)
  - `public/report.html` … 通報フォーム
  - `public/map.html` … 公開マップ
  - `public/mypage.html` … 通報者マイページ
  - `public/review.html` … レビュー画面
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
   - `/img/` 配下の画像配信はレビュアー認証必須(私有地の写真のため)。唯一の例外は
     通報者本人が自分の投稿を `/api/mypage` の一覧からタップして見る場合
     (`?reporter_id=` が該当 report の reporter_id と一致する時のみ)。
     image_key/thumb_key 自体に推測不能な通報IDが埋め込まれているため、この例外は
     `/api/mypage` が元々持つ露出面(reporter_id を知っていれば履歴が見える)を
     広げない。

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

4. **AI 判定(未実装)は種の同定をさせない。**
   「幹が写っているか」「木くず状のものがあるか」「明らかに無関係か」の足切りのみ。
   クビアカ固有の判定は人間(レビュー画面)が行う。AI 導入時も人間レビューを残し、精度を実測する。
    AI は Workers AI を予定。無料枠(1日1万ニューロン)では vision で1日数百件が上限の見込み。

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
`reactions`(スタンプ), `coord_access_log`(座標閲覧監査), `teams`(地域チーム)。
公開用ビュー `public_mesh_stats` は構造的に座標を含まない。

reports.status: queued / auto_rejected / pending_review / provisional /
                confirmed / rejected / duplicate
  ※現状、新規通報は pending_review で入る(AI 未実装のため)。AI 導入時に queued 始まりへ戻す。
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
      控えめな横長導線の2カラムUI) / 通報者向けGoogleログイン(任意、ゲスト併存)。
未着手: AI一次判定(設計プラン確定・実装は指示待ち) / チーム機能 / Cloudflare Access 移行 / 独自ドメイン。

※ 未調査エリア表示は `survey_mesh`(自治体の調査対象データ)未整備のため、「bboxを現在のズーム粒度
  (mesh3/4/5)のグリッドで理論上列挙し、通報が1件も無いセル」を暫定的な代用指標として使っている
  (`public/mesh.js` の `meshGrid`/`meshGridCount`、`map.html` 内で完結、新規APIなし)。山林・水面など
  本来調査対象外のエリアも区別なく「未調査」表示になる既知の制約あり。自治体側の実データが手に入ったら
  `survey_mesh` テーブルを使う本来の設計に置き換える。
  この未調査判定は250m(mesh5)より細かくしない — 通報の存在有無を250mより細かい粒度で開示することは
  ルール1(一般公開は250m/1kmメッシュ集計まで)と実質的に矛盾するため。徒歩スケールの体験は、
  既に正確な座標が公開済みの公有地確定ピンの周辺だけに「確認済み」円を重ねる形で補っている
  (ピンは元々exactな座標なので、これは新たな情報開示にはならない)。
