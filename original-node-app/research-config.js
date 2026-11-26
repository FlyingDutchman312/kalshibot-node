'use strict';
function inspect(raw){
 const present=typeof raw==='string';
 const value=present?raw.trim():'';
 const valid=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
 return {present,valid,startUtc:valid?new Date(value).toISOString():null,reason:valid?'valid':!present?'missing':!value?'empty':'invalid UTC format'};
}
module.exports={inspect};
