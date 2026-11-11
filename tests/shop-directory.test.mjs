import test from "node:test";
import assert from "node:assert/strict";
import { listedGroups, registerChoices } from "../mainstream/shop-directory.mjs";
import { shopFields, shopIcons } from "../shared/shop-profile.mjs";

// Archive the four exact accounts, even if renamed or restored from an older directory cache.
const seeds = [
  "4SuDmQR72DnjC5GZ78oDk7u4G2w5edNFuVGKFRfEZsLU",
  "EX9aaEQJ4Uzd6ydpJbP4G32i3udkdg6VdVLsXZ3PWtLa",
  "HWN3xPwGBAd9UjNgU34eFvVSjEVo74ow16TgBMrxi1pD",
  "J9PGMWgkXXH2dhoZpdGtNyRA2xbtmLJPM4SnGWMvE3wC",
];
test("archived group IDs disappear from both directories, not other groups with the same name", () => {
  const groups = [...seeds,"new"].map(id => ({id, name:"川辺の市場", owner:"me"}));
  const stores = groups.map(g => ({group:g.id,to:"me"}));
  assert.deepEqual(listedGroups(groups), groups.slice(-1));
  for (const receiving of [false,true])
    assert.deepEqual(registerChoices(stores,{groups,rows:[]},"me",receiving), stores.slice(-1));
});

test("payment lists owned and admitted communities; receiving lists this wallet’s stores", () => {
  const groups = ["owned","joined","private","pending","open","other"].map(id => ({
    id, owner:id === "owned" ? "me" : "admin", visibility:id === "private" ? "private" : "public",
  }));
  const member = (group,to,status) => ({tag:33,group,to,status});
  const rows = [member("joined","me",2),member("private","me",2),member("pending","me",1),member("other","them",2)];
  const stores = groups.map(g => ({group:g.id,to:g.id === "open" ? "me" : "shop"}));
  assert.deepEqual(registerChoices(stores,{groups,rows},"me",false),stores.slice(0,3));
  assert.deepEqual(registerChoices(stores,{groups,rows},"me",true),[stores[4]]);
  assert.deepEqual(registerChoices(stores,{groups,rows},"newcomer",false),[]);
});

test("every selectable icon round-trips through profile validation", () => {
  assert.ok(shopIcons.length >= 30);
  for (const icon of ["🐶","🦉","🐙","🍜","✂️","🏪"]) assert.ok(shopIcons.includes(icon));
  const fields = {title:"雑貨屋",caption:"",is_test:false};
  for (const icon of shopIcons) assert.equal(shopFields({...fields,icon}).icon,icon);
  assert.throws(()=>shopFields({...fields,icon:"not an icon"}));
});
