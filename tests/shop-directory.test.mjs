import test from "node:test";
import assert from "node:assert/strict";
import { listedGroups, registerChoices } from "../mainstream/shop-directory.mjs";
import { shopTitle, shopEditor } from "../mainstream/shop-profile.mjs";
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
  for (const receiving of [false,true]) {
    const stores = groups.map(g => ({group:g.id,to:receiving ? "me" : "them"}));
    assert.deepEqual(registerChoices(stores,{groups,rows:[]},"me",receiving), stores.slice(-1));
  }
});

test("payment lists other stores in owned and admitted communities; receiving lists this wallet’s stores", () => {
  const groups = ["owned","joined","private","pending","open","other"].map(id => ({
    id, owner:id === "owned" ? "me" : "admin", visibility:id === "private" ? "private" : "public",
  }));
  const member = (group,to,status) => ({tag:33,group,to,status});
  const rows = [member("joined","me",2),member("private","me",2),member("pending","me",1),member("other","them",2)];
  const ownStore = {group:"owned",to:"me"};
  const stores = [...groups.map(g => ({group:g.id,to:g.id === "open" ? "me" : "shop"})), ownStore];
  assert.deepEqual(registerChoices(stores,{groups,rows},"me",false),stores.slice(0,3));
  assert.deepEqual(registerChoices(stores,{groups,rows},"me",true),[stores[4], ownStore]);
  assert.deepEqual(registerChoices(stores,{groups,rows},"newcomer",false),[]);
});

test("every selectable icon round-trips through profile validation", () => {
  assert.ok(shopIcons.length >= 30);
  for (const icon of ["🐶","🦉","🐙","🍜","✂️","🏪"]) assert.ok(shopIcons.includes(icon));
  const fields = {title:"雑貨屋",caption:"",is_test:false};
  for (const icon of ["", undefined, ...shopIcons]) assert.equal(shopFields({...fields,icon}).icon,icon ?? "");
  for (const icon of ["なし", "not an icon", " ", null, 0, false, [], {}])
    assert.throws(()=>shopFields({...fields,icon}));
});

test("caption-only edits allow an empty or omitted icon at the 140-character limit", () => {
  const fields = {title:"雑貨屋",caption:"あ".repeat(140),is_test:false};
  for (const icon of ["", undefined]) {
    assert.deepEqual(shopFields({...fields,icon}), {...fields,icon:""});
    assert.throws(()=>shopFields({...fields,icon,caption:"あ".repeat(141)}));
  }
});

test("recipient choices exclude both primary and sender addresses using primary membership",()=>{
  const state={groups:[{id:"g",owner:"main"}],rows:[]};
  const stores=["main","sender","friend"].map(to=>({group:"g",to}));
  assert.deepEqual(registerChoices(stores,state,"main",false,"sender"),[stores[2]]);
  assert.deepEqual(registerChoices(stores,state,"main",true,"sender"),[stores[0]]);
});

test("empty and unset icons render a bare title and default to the first None option", () => {
  for (const icon of ["", undefined]) {
    const store = {id:"shop",name:"雑貨屋",icon};
    assert.equal(shopTitle(store),"雑貨屋");
    assert.match(shopEditor(store,String), /<select name="icon"><option value="">なし<\/option>/);
    assert.doesNotMatch(shopEditor(store,String), / selected/);
  }
  assert.equal(shopTitle({name:"雑貨屋",icon:"🦊"}),"🦊 雑貨屋");
  assert.match(shopEditor({id:"shop",name:"雑貨屋",icon:"🦊"},String), /<option selected>🦊<\/option>/);
});
