import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedLiveShopUrl } from "./taobao-url.ts";

test("recognizes only strict Taobao and Tmall shop host segments", () => {
  for (const url of [
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a",
    "https://shop295973379.taobao.com/category.htm",
    "https://shop.m.taobao.com/shop/shop_index.htm?shop_id=fictional-b",
    "https://store.tmall.com/",
    "http://seller.taobao.com/"
  ]) {
    assert.equal(isSupportedLiveShopUrl(url), true, url);
  }

  for (const url of [
    null,
    "not a url",
    "ftp://shop.taobao.com/shop/view_shop.htm",
    "https://shop.example.com/",
    "https://shopping.taobao.com/",
    "https://shop295973379x.taobao.com/category.htm",
    "https://taobao.com.example.net/shop",
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    "https://item.taobao.com/item.htm?id=example-x1-a"
  ]) {
    assert.equal(isSupportedLiveShopUrl(url), false, String(url));
  }
});
