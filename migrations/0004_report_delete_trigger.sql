-- 通報者本人による誤報の自己削除(レビュー前のみ)を追加するにあたり、
-- survey_mesh の集計が INSERT/UPDATE 時だけ加算されて DELETE 時に戻らない
-- 片手落ちを直しておく。survey_mesh 自体は未調査エリア表示のクライアント
-- 代用ロジックにより現状ほぼ未使用だが、将来の本来設計への移行時に矛盾が
-- 残らないよう対称なトリガーを揃える。
CREATE TRIGGER trg_report_delete_mesh
AFTER DELETE ON reports
BEGIN
  UPDATE survey_mesh
     SET report_count = MAX(0, report_count - 1),
         confirmed_count = CASE WHEN OLD.status = 'confirmed'
                                 THEN MAX(0, confirmed_count - 1) ELSE confirmed_count END
   WHERE mesh3 = OLD.mesh3;
END;
