// 商品区分（Phase 3）: 商品区分レポート.md 2026-07-17 に基づく。
// active/soldout は products_data.js の soldout フラグから導出し、
// archive/duplicate の6件のみここで上書きする（products_data.js は変更しない）。
window.PRODUCT_STATUS_OVERRIDES = {
  '139505242': 'archive',
  '139501824': 'duplicate',
  '139503593': 'duplicate',
  '139503986': 'duplicate',
  '139504553': 'duplicate',
  '139505054': 'duplicate'
};
window.getProductStatus = function (id) {
  var o = window.PRODUCT_STATUS_OVERRIDES[id];
  if (o) return o;
  var p = window.PRODUCTS_DATA && window.PRODUCTS_DATA[id];
  return (p && p.soldout) ? 'soldout' : 'active';
};