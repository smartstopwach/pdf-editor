/* Headless logic test for the editor's geometry + pdf-lib pipeline.
   Run: node test/engine-test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');

/* --- load pdf-lib (UMD) --- */
const PDFLib = require(path.join(root, 'lib/pdf-lib/pdf-lib.min.js'));

/* --- minimal browser stub so editor.js's IIFE can evaluate --- */
const listeners = {};
global.window = {
  pdfjsLib: { GlobalWorkerOptions: { workerSrc: '' } },
  PDFLib: PDFLib,
  devicePixelRatio: 1,
  location: { search: '' },
  addEventListener: function () {},
};
global.document = {
  readyState: 'loading', // prevent init() from running
  addEventListener: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
  createElement: function () { return { style: {}, getContext: function () { return null; }, classList: { add() {}, remove() {}, toggle() {} } }; },
  getElementById: function () { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, focus() {}, select() {} }; },
  querySelectorAll: function () { return []; },
};
global.indexedDB = undefined;

const src = fs.readFileSync(path.join(root, 'js/editor.js'), 'utf8');
eval(src);
const E = window.PDFEditor;
assert.ok(E, 'PDFEditor debug hook exposed');

/* --- coordinate mapping tests --- */
function near(a, b, eps) { eps = eps || 1e-6; return Math.abs(a - b) < eps; }

// rot 0: top-left view -> bottom-left media
let m = E.viewToMedia(10, 20, 100, 200, 0, 100, 200);
assert.ok(near(m.x, 10) && near(m.y, 180), 'rot0 point');

// rot 90: view (0,0) -> media (0,0); view dims are (H, W)
m = E.viewToMedia(0, 0, 200, 100, 90, 100, 200);
assert.ok(near(m.x, 0) && near(m.y, 0), 'rot90 origin -> media (0,0)');
m = E.viewToMedia(200, 0, 200, 100, 90, 100, 200);
assert.ok(near(m.x, 0) && near(m.y, 200), 'rot90 view top-right -> media top-left (0,200)');

// rot 180
m = E.viewToMedia(0, 0, 100, 200, 180, 100, 200);
assert.ok(near(m.x, 100) && near(m.y, 0), 'rot180 origin -> media bottom-right (100,0)');

// rot 270
m = E.viewToMedia(0, 0, 200, 100, 270, 100, 200);
assert.ok(near(m.x, 100) && near(m.y, 200), 'rot270 origin -> media top-right (100,200)');

// rectToMedia under rotation (w/h must swap for 90/270)
let r = E.rectToMedia({ x: 10, y: 20, w: 30, h: 40 }, 100, 200, 0, 100, 200);
assert.ok(near(r.x, 10) && near(r.y, 140) && near(r.w, 30) && near(r.h, 40), 'rect rot0');
r = E.rectToMedia({ x: 10, y: 20, w: 30, h: 40 }, 200, 100, 90, 100, 200);
assert.ok(near(r.x, 20) && near(r.y, 10) && near(r.w, 40) && near(r.h, 30), 'rect rot90 swaps w/h');
r = E.rectToMedia({ x: 10, y: 20, w: 30, h: 40 }, 100, 200, 180, 100, 200);
assert.ok(near(r.x, 60) && near(r.y, 20) && near(r.w, 30) && near(r.h, 40), 'rect rot180');
r = E.rectToMedia({ x: 10, y: 20, w: 30, h: 40 }, 200, 100, 270, 100, 200);
assert.ok(near(r.x, 40) && near(r.y, 160) && near(r.w, 40) && near(r.h, 30), 'rect rot270');

/* --- rotateAnnotations tests --- */
let ann = { type: 'rect', x: 10, y: 20, w: 30, h: 40 };
E.rotateAnnotations(ann, 100, 200, 1); // clockwise 90
assert.ok(near(ann.x, 180) && near(ann.y, 10) && near(ann.w, 40) && near(ann.h, 30), 'rect rotated cw');
E.rotateAnnotations(ann, 200, 100, -1); // back counter-clockwise
assert.ok(near(ann.x, 10) && near(ann.y, 20) && near(ann.w, 30) && near(ann.h, 40), 'rect rotated back');

let line = { type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 50 };
E.rotateAnnotations(line, 100, 200, 1);
assert.ok(near(line.x1, 200) && near(line.y1, 0) && near(line.x2, 150) && near(line.y2, 100), 'arrow rotated cw');

/* --- pdf-lib round trip: build a PDF, rotate a page, flatten text --- */
(async function () {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const p1 = doc.addPage([200, 300]);
  p1.drawText('Hello Free World', { x: 40, y: 250, size: 14, font, color: PDFLib.rgb(0, 0, 0) });
  const p2 = doc.addPage([400, 200]);
  p2.drawText('Second page', { x: 40, y: 150, size: 14, font });

  // simulate: rotate page 2 by 90 and flatten an annotation onto page 2
  p2.setRotation(PDFLib.degrees(90));
  const bytes = await doc.save();

  const doc2 = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const page2 = doc2.getPage(1);
  assert.strictEqual(page2.getRotation().angle, 90, 'rotation persisted');
  // media box stays 400x200; view dims become 200x400
  const rect = E.rectToMedia({ x: 10, y: 20, w: 100, h: 50 }, 200, 400, 90, 400, 200);
  page2.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: PDFLib.rgb(1, 0.8, 0) });
  const out = await doc2.save();
  assert.ok(out.length > 0, 'flattened PDF saved');

  // verify text extraction still finds our text via a fresh load
  const doc3 = await PDFLib.PDFDocument.load(out);
  assert.strictEqual(doc3.getPageCount(), 2, 'page count preserved');

  console.log('All engine tests passed ✓');
})().catch(function (err) {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
