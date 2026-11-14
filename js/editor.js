/* Free PDF Editor — engine.
   Everything runs client-side: PDF.js renders pages, pdf-lib applies page
   operations and flattens annotations into the downloaded PDF. */
(function () {
  'use strict';

  var PDFLib = window.PDFLib;
  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */
  var state = {
    pdfjsDoc: null,
    pdfLibDoc: null,
    libBytes: null,        // current pdf-lib byte stream (source of truth for page ops)
    fileName: 'document.pdf',
    zoom: 1,
    fitZoom: 1,
    tool: 'select',
    selectedId: null,
    pages: [],            // {num, baseW, baseH, wrap, canvas, overlay, ctx, octx, anns: []}
    annotations: [],      // flat list, each has .page (index)
    props: { color: '#1d6fff', width: 3, opacity: 0.4, font: 'Helvetica', size: 14 },
    currentMatches: [],   // [{page, rects:[{x,y,w,h}], text}]
    rendering: false,
  };

  var FONT_MAP = {
    'Helvetica': { lib: PDFLib.StandardFonts.Helvetica, canvas: 'Helvetica, Arial, sans-serif', bold: false },
    'Helvetica-Bold': { lib: PDFLib.StandardFonts.HelveticaBold, canvas: 'Helvetica, Arial, sans-serif', bold: true },
    'Times-Roman': { lib: PDFLib.StandardFonts.TimesRoman, canvas: '"Times New Roman", serif', bold: false },
    'Courier': { lib: PDFLib.StandardFonts.Courier, canvas: '"Courier New", monospace', bold: false },
  };

  function $(id) { return document.getElementById(id); }
  function uid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    return PDFLib.rgb(
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255
    );
  }
  function canvasFont(fontName, size) {
    var fm = FONT_MAP[fontName] || FONT_MAP['Helvetica'];
    return (fm.bold ? 'bold ' : '') + size + 'px ' + fm.canvas;
  }
  function status(msg) { $('status-msg').textContent = msg || ''; }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  /* ------------------------------------------------------------------ */
  /* file loading                                                       */
  /* ------------------------------------------------------------------ */
  function loadFromInput(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('pdf') === -1 && /\.(pdf)$/i.test(file.name) === false) {
      toast('Please choose a PDF file.', true);
      return;
    }
    state.fileName = file.name || 'document.pdf';
    var reader = new FileReader();
    reader.onload = function () {
      openDocument(new Uint8Array(reader.result));
    };
    reader.onerror = function () { toast('Could not read the file.', true); };
    reader.readAsArrayBuffer(file);
  }

  function openDocument(bytes) {
    status('Loading document…');
    pdfjsLib.getDocument({ data: bytes.slice ? bytes.slice(0) : bytes }).promise.then(function (doc) {
      state.pdfjsDoc = doc;
      return PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    }).then(function (libDoc) {
      state.pdfLibDoc = libDoc;
      state.libBytes = null;
      $('file-name').textContent = state.fileName;
      $('btn-download').disabled = false;
      $('ed-empty').classList.add('hidden');
      $('ed-pages').classList.add('has-content');
      buildPages(state.pdfjsDoc.numPages).then(function () {
        renderPageList();
        fitWidth(true);
        status('Pages loaded — pick a tool and start editing.');
      });
    }).catch(function (err) {
      console.error(err);
      toast('Could not open this PDF. If it is password-protected, remove the password first.', true);
    });
  }

  /* ------------------------------------------------------------------ */
  /* page rendering                                                     */
  /* ------------------------------------------------------------------ */
  function buildPages(count) {
    var container = $('ed-pages');
    container.innerHTML = '';
    state.pages = [];
    // state.annotations is intentionally preserved: page operations remap it
    // and the rebuilt pages must pick their annotations back up.
    var chain = Promise.resolve();
    for (var i = 0; i < count; i++) {
      (function (idx) {
        chain = chain.then(function () { return buildPage(idx); });
      })(i);
    }
    return chain.then(function () {
      // redistribute annotations to the rebuilt pages
      state.pages.forEach(function (pageObj) {
        pageObj.anns = state.annotations.filter(function (a) { return a.page === pageObj.num - 1; });
        drawAnnotations(pageObj);
      });
    });
  }

  function buildPage(idx) {
    return state.pdfjsDoc.getPage(idx + 1).then(function (page) {
      var vp = page.getViewport({ scale: 1 });
      var rawVp = page.getViewport({ scale: 1, rotation: 0 });
      var wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      var canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      var overlay = document.createElement('canvas');
      overlay.className = 'overlay-canvas';
      wrap.appendChild(canvas);
      wrap.appendChild(overlay);
      $('ed-pages').appendChild(wrap);

      var pageObj = {
        num: idx + 1,
        baseW: vp.width,
        baseH: vp.height,
        rawH: rawVp.height,
        rawW: rawVp.width,
        wrap: wrap, canvas: canvas, overlay: overlay,
        ctx: canvas.getContext('2d'),
        octx: overlay.getContext('2d'),
        anns: [],
        pdfPage: page,
        renderToken: 0,
      };
      state.pages.push(pageObj);

      renderPage(pageObj);
      wireOverlay(pageObj);
      return pageObj;
    });
  }

  function renderPage(pageObj) {
    var token = ++pageObj.renderToken;
    var dpr = window.devicePixelRatio || 1;
    var scale = state.zoom * dpr;
    var vp = pageObj.pdfPage.getViewport({ scale: scale });
    pageObj.canvas.width = vp.width;
    pageObj.canvas.height = vp.height;
    pageObj.overlay.width = vp.width;
    pageObj.overlay.height = vp.height;
    pageObj.wrap.style.width = (pageObj.baseW * state.zoom) + 'px';
    pageObj.wrap.style.height = (pageObj.baseH * state.zoom) + 'px';

    var renderTask = pageObj.pdfPage.render({ canvasContext: pageObj.ctx, viewport: vp });
    return renderTask.promise.then(function () {
      if (token !== pageObj.renderToken) return; // superseded
      pageObj.octx.clearRect(0, 0, pageObj.overlay.width, pageObj.overlay.height);
      drawAnnotations(pageObj);
    }).catch(function (err) {
      if (err && err.name !== 'RenderingCancelledException') { console.error(err); }
    });
  }

  function rerenderAll() {
    status('Rendering…');
    var chain = Promise.resolve();
    state.pages.forEach(function (p) {
      chain = chain.then(function () { return renderPage(p); });
    });
    chain.then(function () { status(''); });
  }

  function fitWidth(apply) {
    var container = $('ed-pages');
    var avail = container.clientWidth - 56;
    var widest = state.pages.reduce(function (m, p) { return Math.max(m, p.baseW); }, 1);
    var z = Math.min(3, Math.max(0.25, avail / widest));
    if (apply) setZoom(z);
    else state.fitZoom = z;
  }

  function setZoom(z) {
    state.zoom = Math.min(4, Math.max(0.25, z));
    $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
    rerenderAll();
  }

  /* ------------------------------------------------------------------ */
  /* coordinate helpers                                                 */
  /* ------------------------------------------------------------------ */
  function eventToPoints(e, pageObj) {
    var rect = pageObj.overlay.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / state.zoom,
      y: (e.clientY - rect.top) / state.zoom,
    };
  }

  /* ------------------------------------------------------------------ */
  /* annotation drawing (canvas)                                        */
  /* ------------------------------------------------------------------ */
  function drawAnnotations(pageObj) {
    var ctx = pageObj.ctx;
    var dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(state.zoom * dpr, 0, 0, state.zoom * dpr, 0, 0);

    pageObj.anns.forEach(function (a) {
      drawAnnotation(ctx, a);
      if (state.selectedId === a.id) {
        var b = bboxOf(a);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.strokeStyle = '#1d6fff';
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        ctx.restore();
      }
    });
    ctx.restore();
  }

  function drawAnnotation(ctx, a) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    switch (a.type) {
      case 'text':
        ctx.fillStyle = a.color;
        ctx.font = canvasFont(a.font, a.size);
        var lines = (a.text || '').split('\n');
        var lh = a.size * 1.25;
        lines.forEach(function (ln, i) {
          ctx.fillText(ln, a.x, a.y + i * lh);
        });
        break;
      case 'draw':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        a.segs.forEach(function (s) {
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        });
        break;
      case 'highlight':
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = a.color;
        ctx.fillRect(a.x, a.y, a.w, a.h);
        ctx.globalAlpha = 1;
        break;
      case 'rect':
        ctx.fillStyle = a.fill;
        ctx.globalAlpha = a.fillOpacity;
        ctx.fillRect(a.x, a.y, a.w, a.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.strokeRect(a.x, a.y, a.w, a.h);
        break;
      case 'ellipse':
        ctx.fillStyle = a.fill;
        ctx.globalAlpha = a.fillOpacity;
        ctx.beginPath();
        ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.beginPath();
        ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'line':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        break;
      case 'arrow':
        ctx.strokeStyle = a.color;
        ctx.fillStyle = a.color;
        ctx.lineWidth = a.width;
        var ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        var head = Math.max(9, a.width * 3.5);
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - head * Math.cos(ang - 0.42), a.y2 - head * Math.sin(ang - 0.42));
        ctx.lineTo(a.x2 - head * Math.cos(ang + 0.42), a.y2 - head * Math.sin(ang + 0.42));
        ctx.closePath();
        ctx.fill();
        break;
      case 'note':
        var nw = 110, nh = 110;
        ctx.fillStyle = a.color;
        ctx.globalAlpha = 0.92;
        roundRect(ctx, a.x, a.y, nw, nh, 8);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(a.x + nw - 20, a.y + nh);
        ctx.lineTo(a.x + nw, a.y + nh - 20);
        ctx.lineTo(a.x + nw, a.y + nh);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = canvasFont('Helvetica', 26);
        ctx.fillText('Note', a.x + 14, a.y + 42);
        break;
      case 'image':
        if (a.imgEl) {
          ctx.drawImage(a.imgObj || a.imgEl, a.x, a.y, a.w, a.h);
        }
        break;
      case 'signature':
        if (a.imgEl) {
          ctx.drawImage(a.imgEl, a.x, a.y, a.w, a.h);
        }
        break;
      case 'replace':
        // white-out original + draw replacement
        ctx.fillStyle = '#ffffff';
        a.rects.forEach(function (r) { ctx.fillRect(r.x, r.y, r.w, r.h); });
        ctx.fillStyle = a.color;
        ctx.font = canvasFont(a.font, a.size);
        ctx.fillText(a.text, a.x, a.y);
        break;
      case 'searchhit':
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#ffd84d';
        a.rects.forEach(function (r) { ctx.fillRect(r.x, r.y, r.w, r.h); });
        ctx.globalAlpha = 1;
        break;
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ */
  /* hit testing & bounding boxes                                        */
  /* ------------------------------------------------------------------ */
  function bboxOf(a) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    function add(x, y) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    switch (a.type) {
      case 'text': {
        var lines = (a.text || '').split('\n');
        var tmp = document.createElement('canvas').getContext('2d');
        tmp.font = canvasFont(a.font, a.size);
        var lh = a.size * 1.25;
        var w = 0;
        lines.forEach(function (ln) { w = Math.max(w, tmp.measureText(ln).width); });
        return { x: a.x, y: a.y - a.size, w: w, h: lh * lines.length };
      }
      case 'draw':
        a.segs.forEach(function (s) { add(s.x1, s.y1); add(s.x2, s.y2); });
        break;
      case 'highlight': return { x: a.x, y: a.y, w: a.w, h: a.h };
      case 'rect': return { x: a.x, y: a.y, w: a.w, h: a.h };
      case 'ellipse': return { x: a.x, y: a.y, w: a.w, h: a.h };
      case 'line':
      case 'arrow': add(a.x1, a.y1); add(a.x2, a.y2); break;
      case 'note': return { x: a.x, y: a.y, w: 110, h: 110 };
      case 'image':
      case 'signature': return { x: a.x, y: a.y, w: a.w, h: a.h };
      case 'replace':
        a.rects.forEach(function (r) { add(r.x, r.y); add(r.x + r.w, r.y + r.h); });
        break;
      case 'searchhit':
        a.rects.forEach(function (r) { add(r.x, r.y); add(r.x + r.w, r.y + r.h); });
        break;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function hitTest(a, x, y) {
    var b = bboxOf(a);
    if (a.type === 'ellipse') {
      var cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      var rx = a.w / 2, ry = a.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      var dx = (x - cx) / rx, dy = (y - cy) / ry;
      return dx * dx + dy * dy <= 1.05;
    }
    if (a.type === 'line' || a.type === 'arrow') {
      return distToSeg(x, y, a.x1, a.y1, a.x2, a.y2) <= Math.max(6, a.width * 2);
    }
    if (a.type === 'draw') {
      return a.segs.some(function (s) {
        return distToSeg(x, y, s.x1, s.y1, s.x2, s.y2) <= Math.max(6, a.width * 2);
      });
    }
    return x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2;
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function annotationAt(pageObj, x, y) {
    for (var i = pageObj.anns.length - 1; i >= 0; i--) {
      var a = pageObj.anns[i];
      if (a.type === 'searchhit') continue;
      if (hitTest(a, x, y)) return a;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* annotation add / remove / move                                     */
  /* ------------------------------------------------------------------ */
  function addAnnotation(ann) {
    ann.id = ann.id || uid();
    state.annotations.push(ann);
    var pageObj = state.pages[ann.page];
    if (pageObj) {
      pageObj.anns.push(ann);
      drawAnnotations(pageObj);
    }
    return ann;
  }

  function removeAnnotation(ann) {
    var i = state.annotations.indexOf(ann);
    if (i >= 0) state.annotations.splice(i, 1);
    var pageObj = state.pages[ann.page];
    if (pageObj) {
      var j = pageObj.anns.indexOf(ann);
      if (j >= 0) pageObj.anns.splice(j, 1);
      drawAnnotations(pageObj);
    }
  }

  function moveAnnotation(ann, dx, dy) {
    switch (ann.type) {
      case 'text': ann.x += dx; ann.y += dy; break;
      case 'highlight': ann.x += dx; ann.y += dy; break;
      case 'rect': ann.x += dx; ann.y += dy; break;
      case 'ellipse': ann.x += dx; ann.y += dy; break;
      case 'note': ann.x += dx; ann.y += dy; break;
      case 'image': ann.x += dx; ann.y += dy; break;
      case 'signature': ann.x += dx; ann.y += dy; break;
      case 'line': ann.x1 += dx; ann.y1 += dy; ann.x2 += dx; ann.y2 += dy; break;
      case 'arrow': ann.x1 += dx; ann.y1 += dy; ann.x2 += dx; ann.y2 += dy; break;
      case 'draw': ann.segs.forEach(function (s) { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }); break;
      case 'replace':
        ann.x += dx; ann.y += dy;
        ann.rects.forEach(function (r) { r.x += dx; r.y += dy; });
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* pointer interactions on the overlay canvases                        */
  /* ------------------------------------------------------------------ */
  function wireOverlay(pageObj) {
    var overlay = pageObj.overlay;
    var drag = null; // {kind, ...}

    overlay.addEventListener('pointerdown', function (e) {
      if (!state.pdfjsDoc) return;
      var p = eventToPoints(e, pageObj);
      var tool = state.tool;

      if (tool === 'select') {
        var ann = annotationAt(pageObj, p.x, p.y);
        if (ann) {
          state.selectedId = ann.id;
          drag = { kind: 'move', ann: ann, start: p, orig: JSON.parse(JSON.stringify(ann)) };
          drawAnnotations(pageObj);
        } else {
          state.selectedId = null;
          drawAnnotations(pageObj);
        }
        return;
      }

      if (tool === 'delete') {
        var target = annotationAt(pageObj, p.x, p.y);
        if (target) {
          removeAnnotation(target);
          toast('Annotation deleted');
        }
        return;
      }

      if (tool === 'text') {
        var existing = annotationAt(pageObj, p.x, p.y);
        if (existing && existing.type === 'text') {
          openTextPopover(p, existing.text, existing, pageObj);
        } else {
          openTextPopover(p, '', null, pageObj);
        }
        return;
      }

      if (tool === 'note') {
        var note = addAnnotation({
          type: 'note', page: pageObj.num - 1, x: p.x, y: p.y, color: state.props.color,
        });
        state.selectedId = note.id;
        return;
      }

      if (tool === 'draw') {
        drag = { kind: 'draw', segs: [{ x1: p.x, y1: p.y, x2: p.x, y2: p.y }], last: p };
        e.preventDefault();
      } else if (tool === 'highlight') {
        drag = { kind: 'highlight', x: p.x, y: p.y, w: 0, h: 0 };
        e.preventDefault();
      } else if (tool === 'rect' || tool === 'ellipse') {
        drag = { kind: tool, x: p.x, y: p.y, w: 0, h: 0 };
        e.preventDefault();
      } else if (tool === 'line' || tool === 'arrow') {
        drag = { kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        e.preventDefault();
      }
    });

    overlay.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var p = eventToPoints(e, pageObj);
      var octx = pageObj.octx;
      octx.clearRect(0, 0, pageObj.overlay.width, pageObj.overlay.height);
      var dpr = window.devicePixelRatio || 1;
      octx.setTransform(state.zoom * dpr, 0, 0, state.zoom * dpr, 0, 0);

      if (drag.kind === 'move') {
        var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        moveAnnotation(drag.ann, dx, dy);
        drawAnnotations(pageObj);
        return;
      }
      if (drag.kind === 'draw') {
        drag.segs.push({ x1: drag.last.x, y1: drag.last.y, x2: p.x, y2: p.y });
        drag.last = p;
        drawPreviewStrokes(octx, drag.segs, state.props);
      } else if (drag.kind === 'highlight') {
        drag.w = p.x - drag.x; drag.h = p.y - drag.y;
        octx.globalAlpha = 0.4;
        octx.fillStyle = state.props.color;
        normRect(octx, drag.x, drag.y, drag.w, drag.h);
        octx.fill();
        octx.globalAlpha = 1;
      } else if (drag.kind === 'rect') {
        drag.w = p.x - drag.x; drag.h = p.y - drag.y;
        octx.strokeStyle = state.props.color;
        octx.lineWidth = state.props.width;
        normRect(octx, drag.x, drag.y, drag.w, drag.h);
        octx.stroke();
      } else if (drag.kind === 'ellipse') {
        drag.w = p.x - drag.x; drag.h = p.y - drag.y;
        octx.strokeStyle = state.props.color;
        octx.lineWidth = state.props.width;
        octx.beginPath();
        octx.ellipse(drag.x + drag.w / 2, drag.y + drag.h / 2, Math.abs(drag.w / 2), Math.abs(drag.h / 2), 0, 0, Math.PI * 2);
        octx.stroke();
      } else if (drag.kind === 'line' || drag.kind === 'arrow') {
        drag.x2 = p.x; drag.y2 = p.y;
        octx.strokeStyle = state.props.color;
        octx.lineWidth = state.props.width;
        octx.beginPath();
        octx.moveTo(drag.x1, drag.y1);
        octx.lineTo(drag.x2, drag.y2);
        octx.stroke();
      }
    });

    function endDrag(e) {
      if (!drag) return;
      var p = eventToPoints(e, pageObj);
      var d = drag;
      drag = null;
      pageObj.octx.clearRect(0, 0, pageObj.overlay.width, pageObj.overlay.height);

      if (d.kind === 'move') { drawAnnotations(pageObj); return; }

      if (d.kind === 'draw') {
        if (d.segs.length) {
          var ann = addAnnotation({
            type: 'draw', page: pageObj.num - 1, segs: d.segs,
            color: state.props.color, width: state.props.width,
          });
          state.selectedId = ann.id;
        }
      } else if (d.kind === 'highlight') {
        var r = normRectObj(d.x, d.y, d.w, d.h);
        if (r.w > 2 && r.h > 2) {
          var h = addAnnotation({
            type: 'highlight', page: pageObj.num - 1, x: r.x, y: r.y, w: r.w, h: r.h,
            color: state.props.color,
          });
          state.selectedId = h.id;
        }
      } else if (d.kind === 'rect') {
        var rr = normRectObj(d.x, d.y, d.w, d.h);
        if (rr.w > 2 && rr.h > 2) {
          var a2 = addAnnotation({
            type: 'rect', page: pageObj.num - 1, x: rr.x, y: rr.y, w: rr.w, h: rr.h,
            color: state.props.color, fill: state.props.color, fillOpacity: state.props.opacity, width: state.props.width,
          });
          state.selectedId = a2.id;
        }
      } else if (d.kind === 'ellipse') {
        var re = normRectObj(d.x, d.y, d.w, d.h);
        if (re.w > 2 && re.h > 2) {
          var a3 = addAnnotation({
            type: 'ellipse', page: pageObj.num - 1, x: re.x, y: re.y, w: re.w, h: re.h,
            color: state.props.color, fill: state.props.color, fillOpacity: state.props.opacity, width: state.props.width,
          });
          state.selectedId = a3.id;
        }
      } else if (d.kind === 'line' || d.kind === 'arrow') {
        var len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
        if (len > 3) {
          var a4 = addAnnotation({
            type: d.kind, page: pageObj.num - 1, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
            color: state.props.color, width: state.props.width,
          });
          state.selectedId = a4.id;
        }
      }
    }

    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);
  }

  function normRect(ctx, x, y, w, h) {
    var nx = w < 0 ? x + w : x, ny = h < 0 ? y + h : y;
    var nw = Math.abs(w), nh = Math.abs(h);
    ctx.fillRect ? ctx.fillRect(nx, ny, nw, nh) : null;
  }
  function normRectObj(x, y, w, h) {
    return {
      x: w < 0 ? x + w : x, y: h < 0 ? y + h : y,
      w: Math.abs(w), h: Math.abs(h),
    };
  }
  function drawPreviewStrokes(ctx, segs, props) {
    ctx.strokeStyle = props.color;
    ctx.lineWidth = props.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    segs.forEach(function (s) {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    });
  }

  /* ------------------------------------------------------------------ */
  /* text popover                                                       */
  /* ------------------------------------------------------------------ */
  var popoverState = { pageObj: null, target: null, x: 0, y: 0 };

  function openTextPopover(p, text, target, pageObj) {
    popoverState.target = target || null;
    popoverState.pageObj = pageObj || state.pages[0];
    popoverState.x = p.x; popoverState.y = p.y;
    var pop = $('text-popover');
    var input = $('text-popover-input');
    input.value = text || '';
    pop.classList.remove('hidden');
    // position in screen coords, anchored to the page the user clicked
    var zoom = state.zoom;
    var rect = popoverState.pageObj.wrap.getBoundingClientRect();
    var left = rect.left + p.x * zoom + 14;
    var top = rect.top + p.y * zoom - 46;
    pop.style.left = Math.max(8, Math.min(left, window.innerWidth - 300)) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    input.focus();
    input.select();
  }

  function commitTextPopover() {
    var pop = $('text-popover');
    var input = $('text-popover-input');
    var text = input.value;
    var pageObj = popoverState.pageObj;
    pop.classList.add('hidden');
    if (!pageObj) return;
    if (!text.trim()) {
      if (popoverState.target) removeAnnotation(popoverState.target);
      return;
    }
    var props = state.props;
    if (popoverState.target) {
      var t = popoverState.target;
      t.text = text;
      t.color = props.color;
      t.font = props.font;
      t.size = props.size;
      drawAnnotations(pageObj);
    } else {
      var ann = addAnnotation({
        type: 'text', page: pageObj.num - 1, x: popoverState.x, y: popoverState.y,
        text: text, color: props.color, font: props.font, size: props.size,
      });
      state.selectedId = ann.id;
    }
  }

  /* ------------------------------------------------------------------ */
  /* find & replace                                                     */
  /* ------------------------------------------------------------------ */
  function clearSearchHits() {
    state.currentMatches = [];
    state.pages.forEach(function (p) {
      p.anns = p.anns.filter(function (a) { return a.type !== 'searchhit'; });
      drawAnnotations(p);
    });
  }

  function findText(query) {
    clearSearchHits();
    if (!query) { $('find-status').textContent = ''; return Promise.resolve(); }
    var matches = [];
    var chain = Promise.resolve();

    state.pages.forEach(function (pageObj, pi) {
      chain = chain.then(function () {
        return pageObj.pdfPage.getTextContent().then(function (tc) {
          var items = tc.items.filter(function (it) { return it.str && it.str.trim(); });
          var concat = items.map(function (it) { return it.str; }).join('');
          var idx = 0;
          var positions = [];
          items.forEach(function (it) {
            positions.push({ item: it, start: idx });
            idx += it.str.length;
          });
          var rawH = pageObj.rawH || pageObj.baseH;
          var lower = concat.toLowerCase();
          var q = query.toLowerCase();
          var pos = lower.indexOf(q);
          while (pos !== -1) {
            var end = pos + q.length;
            var from = null, to = null;
            for (var i = 0; i < positions.length; i++) {
              var ps = positions[i];
              if (ps.start <= pos && from === null) from = i;
              if (ps.start < end) to = i;
            }
            if (from === null || to === null) break;
            var rects = [];
            var firstBaseline = null;
            for (var j = from; j <= to; j++) {
              var str = items[j].str;
              var t = items[j].transform;
              var fs = Math.hypot(t[2], t[3]) || 12;
              var itemStart = positions[j].start;
              var charStart = Math.max(0, pos - itemStart);
              var charEnd = Math.min(str.length, end - itemStart);
              var cx0 = t[4] + (str.length ? (charStart / str.length) * items[j].width : 0);
              var cx1 = t[4] + (str.length ? (charEnd / str.length) * items[j].width : t[4]);
              // transform is in bottom-left origin (y up); convert to view coords (top-left)
              var yTop = rawH - t[5] - fs;
              rects.push({ x: cx0, y: yTop, w: cx1 - cx0, h: fs });
              if (firstBaseline === null) firstBaseline = rawH - t[5];
            }
            matches.push({ page: pi, rects: rects, text: concat.slice(pos, end), baseline: firstBaseline });
            pos = lower.indexOf(q, pos + 1);
          }
        });
      });
    });

    return chain.then(function () {
      state.currentMatches = matches;
      matches.forEach(function (m) {
        var pageObj = state.pages[m.page];
        if (pageObj) {
          pageObj.anns.push({ type: 'searchhit', id: uid(), page: m.page, rects: m.rects });
        }
      });
      state.pages.forEach(drawAnnotations);
      var shown = matches.length;
      $('find-status').textContent = shown
        ? shown + (shown === 1 ? ' match found' : ' matches found')
        : 'No matches';
      status(shown ? (shown + ' match(es) found') : 'No matches found');
    });
  }

  function replaceOne() {
    if (!state.currentMatches.length) { toast('No match to replace. Run Find first.', true); return; }
    var m = state.currentMatches.shift();
    var pageObj = state.pages[m.page];
    var text = $('replace-text').value;
    var props = state.props;
    var first = m.rects[0];
    var x = first.x;
    var y = m.baseline != null ? m.baseline : first.y + (first.h || 12);
    var ann = addAnnotation({
      type: 'replace', page: m.page, x: x, y: y, text: text,
      rects: m.rects, color: props.color, font: props.font, size: props.size,
    });
    state.selectedId = ann.id;
    // remove this match's highlight
    for (var i = pageObj.anns.length - 1; i >= 0; i--) {
      var a = pageObj.anns[i];
      if (a.type === 'searchhit' && a.rects === m.rects) { pageObj.anns.splice(i, 1); }
    }
    drawAnnotations(pageObj);
    var left = state.currentMatches.length;
    $('find-status').textContent = left ? left + ' match(es) left' : 'All matches replaced';
  }

  function replaceAll() {
    var n = state.currentMatches.length;
    if (!n) { toast('No matches to replace.', true); return; }
    var text = $('replace-text').value;
    var props = state.props;
    state.currentMatches.forEach(function (m) {
      var pageObj = state.pages[m.page];
      var first = m.rects[0];
      addAnnotation({
        type: 'replace', page: m.page, x: first.x,
        y: m.baseline != null ? m.baseline : first.y + (first.h || 12),
        text: text, rects: m.rects, color: props.color, font: props.font, size: props.size,
      });
      for (var i = pageObj.anns.length - 1; i >= 0; i--) {
        if (pageObj.anns[i].type === 'searchhit' && pageObj.anns[i].rects === m.rects) {
          pageObj.anns.splice(i, 1);
        }
      }
    });
    state.currentMatches = [];
    state.pages.forEach(drawAnnotations);
    $('find-status').textContent = 'Replaced ' + n + ' match(es)';
    toast('Replaced ' + n + ' occurrence(s)');
  }

  /* ------------------------------------------------------------------ */
  /* images & signatures                                                */
  /* ------------------------------------------------------------------ */
  function fileToBytes(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
  }

  function insertImageFile(file) {
    fileToBytes(file).then(function (bytes) {
      var isPng = /png/i.test(file.type) || /\.png$/i.test(file.name);
      var img = new Image();
      img.onload = function () {
        var maxW = 320, maxH = 320;
        var ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        var w = img.naturalWidth * ratio, h = img.naturalHeight * ratio;
        var center = visibleCenter();
        var ann = addAnnotation({
          type: 'image', page: center.page, x: center.x - w / 2, y: center.y - h / 2,
          w: w, h: h, bytes: bytes, ext: isPng ? 'png' : 'jpg',
          imgEl: img, naturalW: img.naturalWidth, naturalH: img.naturalHeight,
        });
        state.selectedId = ann.id;
        toast('Image inserted — click and drag to place it');
      };
      img.onerror = function () { toast('Could not load the image.', true); };
      img.src = URL.createObjectURL(file);
    }).catch(function () { toast('Could not read the image.', true); });
  }

  function visibleCenter() {
    var visible = null;
    var container = $('ed-pages');
    var cRect = container.getBoundingClientRect();
    for (var i = 0; i < state.pages.length; i++) {
      var r = state.pages[i].wrap.getBoundingClientRect();
      if (r.bottom > cRect.top + 50 && r.top < cRect.bottom - 50) { visible = state.pages[i]; break; }
    }
    var pageObj = visible || state.pages[0];
    if (!pageObj) return { page: 0, x: 0, y: 0 };
    return {
      page: pageObj.num - 1,
      x: pageObj.baseW / 2,
      y: pageObj.baseH / 2,
    };
  }

  /* signature modal */
  var sigState = { mode: 'draw', strokes: [], drawing: false, imgEl: null, dataUrl: null };

  function initSignatureModal() {
    var canvas = $('sig-canvas');
    var ctx = canvas.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';

    var pos = null;
    canvas.addEventListener('pointerdown', function (e) {
      sigState.drawing = true;
      sigState.strokes = [];
      var rect = canvas.getBoundingClientRect();
      var sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      pos = { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
      sigState.strokes.push({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!sigState.drawing) return;
      var rect = canvas.getBoundingClientRect();
      var sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      var x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
      var last = sigState.strokes[sigState.strokes.length - 1];
      last.x2 = x; last.y2 = y;
      redrawSig();
    });
    function endSig(e) {
      if (!sigState.drawing) return;
      sigState.drawing = false;
      if (e) {
        var rect = canvas.getBoundingClientRect();
        var sx = canvas.width / rect.width, sy = canvas.height / rect.height;
        var x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
        var last = sigState.strokes[sigState.strokes.length - 1];
        last.x2 = x; last.y2 = y;
      }
      redrawSig();
    }
    canvas.addEventListener('pointerup', endSig);
    canvas.addEventListener('pointercancel', endSig);

    $('sig-clear').addEventListener('click', function () {
      sigState.strokes = [];
      redrawSig();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.sig-tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.sig-tab'), function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        sigState.mode = tab.dataset.mode;
        Array.prototype.forEach.call(document.querySelectorAll('.sig-pane'), function (pane) {
          pane.classList.toggle('hidden', pane.dataset.pane !== sigState.mode);
        });
      });
    });

    $('sig-upload-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var r = new FileReader();
      r.onload = function () {
        sigState.dataUrl = r.result;
        var img = new Image();
        img.onload = function () { sigState.imgEl = img; };
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });

    $('sig-ok').addEventListener('click', function () {
      var dataUrl = null, img = null;
      if (sigState.mode === 'draw') {
        if (!sigState.strokes.length) { toast('Draw your signature first.', true); return; }
        var off = document.createElement('canvas');
        off.width = canvas.width; off.height = canvas.height;
        var octx = off.getContext('2d');
        sigState.strokes.forEach(function (s) {
          octx.beginPath();
          octx.moveTo(s.x1, s.y1);
          octx.lineTo(s.x2, s.y2);
          octx.stroke();
        });
        dataUrl = off.toDataURL('image/png');
      } else if (sigState.mode === 'type') {
        var t = $('sig-type-input').value.trim();
        if (!t) { toast('Type your name first.', true); return; }
        var size = parseInt($('sig-font-size').value, 10);
        var off = document.createElement('canvas');
        off.width = 520; off.height = 200;
        var octx = off.getContext('2d');
        octx.fillStyle = '#111';
        octx.font = 'italic ' + size + 'px "Brush Script MT", "Segoe Script", cursive';
        var w = octx.measureText(t).width;
        octx.fillText(t, (520 - w) / 2, 140);
        dataUrl = off.toDataURL('image/png');
      } else {
        if (!sigState.dataUrl || !sigState.imgEl) { toast('Choose a signature image first.', true); return; }
        dataUrl = sigState.dataUrl;
        img = sigState.imgEl;
      }
      if (!dataUrl) { toast('Nothing to insert.', true); return; }
      var imgEl = img || new Image();
      imgEl.onload = function () {
        var maxW = 320, maxH = 160;
        var ratio = Math.min(maxW / imgEl.naturalWidth, maxH / imgEl.naturalHeight, 1);
        var w = imgEl.naturalWidth * ratio, h = imgEl.naturalHeight * ratio;
        var center = visibleCenter();
        var bytes = null;
        try {
          var bin = atob(dataUrl.split(',')[1]);
          bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch (err) { bytes = null; }
        var ann = addAnnotation({
          type: 'signature', page: center.page, x: center.x - w / 2, y: center.y - h / 2,
          w: w, h: h, dataUrl: dataUrl, bytes: bytes, imgEl: imgEl,
          ext: /jpe?g/i.test(dataUrl) ? 'jpg' : 'png',
        });
        state.selectedId = ann.id;
        $('sig-modal').classList.add('hidden');
        toast('Signature added — drag it into place');
      };
      imgEl.src = dataUrl;
    });

    $('sig-cancel').addEventListener('click', function () { $('sig-modal').classList.add('hidden'); });

    function redrawSig() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.moveTo(10, canvas.height - 12);
      ctx.lineTo(canvas.width - 10, canvas.height - 12);
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (sigState.mode === 'draw') {
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 3;
        sigState.strokes.forEach(function (s) {
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        });
      } else if (sigState.mode === 'type') {
        var t = $('sig-type-input').value.trim();
        if (t) {
          var size = parseInt($('sig-font-size').value, 10);
          ctx.fillStyle = '#111';
          ctx.font = 'italic ' + size + 'px "Brush Script MT", "Segoe Script", cursive';
          var w = ctx.measureText(t).width;
          ctx.fillText(t, (canvas.width - w) / 2, 130);
        }
      } else if (sigState.imgEl) {
        ctx.drawImage(sigState.imgEl, 0, 0, canvas.width, canvas.height);
      }
    }
    sigState.redraw = redrawSig;
    window._redrawSig = redrawSig;
  }

  /* ------------------------------------------------------------------ */
  /* page operations (pdf-lib) + annotation remap                       */
  /* ------------------------------------------------------------------ */
  function rotateAnnotations(ann, oldW, oldH, dir) {
    function rot(x, y) {
      if (dir > 0) return { x: oldH - y, y: x };
      return { x: y, y: oldW - x };
    }
    function swap(a, keyX, keyY) {
      var r = rot(a[keyX], a[keyY]);
      a[keyX] = r.x; a[keyY] = r.y;
    }
    switch (ann.type) {
      case 'text': { var r = rot(ann.x, ann.y); ann.x = r.x; ann.y = r.y; break; }
      case 'highlight':
      case 'rect':
      case 'ellipse':
      case 'note':
      case 'image':
      case 'signature': {
        var r = rot(ann.x, ann.y);
        ann.x = r.x; ann.y = r.y;
        if (ann.w != null && ann.h != null) { var tw = ann.w; ann.w = ann.h; ann.h = tw; }
        break;
      }
      case 'line':
      case 'arrow':
        swap(ann, 'x1', 'y1'); swap(ann, 'x2', 'y2'); break;
      case 'draw':
        ann.segs.forEach(function (s) { swap(s, 'x1', 'y1'); swap(s, 'x2', 'y2'); });
        break;
      case 'replace': {
        var rr = rot(ann.x, ann.y);
        ann.x = rr.x; ann.y = rr.y;
        ann.rects.forEach(function (rc) {
          var p = rot(rc.x, rc.y);
          rc.x = p.x; rc.y = p.y;
          var tw = rc.w; rc.w = rc.h; rc.h = tw;
        });
        break;
      }
      case 'searchhit':
        ann.rects.forEach(function (rc) {
          var p = rot(rc.x, rc.y);
          rc.x = p.x; rc.y = p.y;
          var tw = rc.w; rc.w = rc.h; rc.h = tw;
        });
        break;
    }
  }

  function cloneAnnotation(ann) {
    var c = Object.assign({}, ann, { id: uid() });
    // deep-copy mutable geometry arrays, keep binary payloads by reference
    if (Array.isArray(ann.segs)) c.segs = ann.segs.map(function (s) { return Object.assign({}, s); });
    if (Array.isArray(ann.rects)) c.rects = ann.rects.map(function (r) { return Object.assign({}, r); });
    return c;
  }

  function remapAnnotations(mapping, dupInfo) {
    // mapping[oldPageIndex] = newPageIndex or null (deleted)
    var newList = [];
    state.annotations.forEach(function (ann) {
      var target = mapping[ann.page];
      if (target === null || target === undefined) return;
      if (dupInfo && dupInfo.from === ann.page) {
        // duplicate this annotation onto the duplicated page as well
        var clone = cloneAnnotation(ann);
        clone.page = dupInfo.dupPage;
        newList.push(clone);
      }
      ann.page = target;
      newList.push(ann);
    });
    state.annotations = newList;
  }

  function applyPageOp(op) {
    if (!state.pdfLibDoc) return;
    status('Updating pages…');
    var lib = state.pdfLibDoc;
    var mapping = null, dupInfo = null, rotateInfo = null;

    if (op.type === 'rotate') {
      var p = lib.getPage(op.index);
      var cur = p.getRotation().angle;
      p.setRotation(PDFLib.degrees((cur + 90) % 360));
      mapping = state.pages.map(function (pg, i) { return i; });
      rotateInfo = { index: op.index, dir: 1 };
    } else if (op.type === 'delete') {
      lib.deletePage(op.index);
      mapping = state.pages.map(function (pg, i) {
        return i < op.index ? i : (i > op.index ? i - 1 : null);
      });
    } else if (op.type === 'duplicate') {
      var src = lib.getPage(op.index);
      var copied = lib.insertPage(op.index + 1);
      copied.copyFrom(src);
      // pages before i stay put; page i stays at i; pages after i shift by 1
      mapping = state.pages.map(function (pg, i) { return i <= op.index ? i : i + 1; });
      dupInfo = { from: op.index, dupPage: op.index + 1 };
    } else if (op.type === 'move') {
      var from = op.index, to = op.to;
      lib.movePage(from, to);
      // order[newPos] = oldIndex
      var order = [];
      for (var i = 0; i < state.pages.length; i++) order.push(i);
      order.splice(from, 1);
      order.splice(to, 0, from);
      // mapping[oldIndex] = newPos
      mapping = {};
      order.forEach(function (oldIndex, newPos) { mapping[oldIndex] = newPos; });
    } else if (op.type === 'add') {
      lib.insertPage(lib.getPageCount());
      mapping = state.pages.map(function (pg, i) { return i; });
    }

    return lib.save({ useObjectStreams: false }).then(function (bytes) {
      state.libBytes = bytes;
      if (rotateInfo) {
        var oldW = state.pages[rotateInfo.index].baseW;
        var oldH = state.pages[rotateInfo.index].baseH;
        state.annotations.forEach(function (ann) {
          if (ann.page === rotateInfo.index) rotateAnnotations(ann, oldW, oldH, rotateInfo.dir);
        });
      }
      remapAnnotations(mapping, dupInfo);
      clearSearchHits();
      $('file-name').textContent = state.fileName;
      return rebuildDocument(bytes);
    });
  }

  function rebuildDocument(bytes) {
    return pdfjsLib.getDocument({ data: bytes.slice(0) }).promise.then(function (doc) {
      state.pdfjsDoc = doc;
      return buildPages(doc.numPages);
    }).then(function () {
      fitWidth(false);
      setZoom(state.fitZoom);
      renderPageList();
      status('');
      toast('Page updated');
    });
  }

  /* ------------------------------------------------------------------ */
  /* download / flatten                                                 */
  /* ------------------------------------------------------------------ */
  function viewToMedia(vx, vy, VW, VH, rot, W, H) {
    // view coords (top-left origin) -> media coords (bottom-left origin)
    switch (((rot % 360) + 360) % 360) {
      case 0: return { x: vx, y: H - vy };
      case 90: return { x: vy, y: vx };
      case 180: return { x: W - vx, y: vy };
      case 270: return { x: W - vy, y: H - vx };
      default: return { x: vx, y: H - vy };
    }
  }

  // Convert a view-space (top-left origin) rect to media coords (bottom-left
  // origin), accounting for page rotation. Works for any axis-aligned rect.
  function rectToMedia(r, VW, VH, rot, W, H) {
    var conv = function (x, y) { return viewToMedia(x, y, VW, VH, rot, W, H); };
    var c1 = conv(r.x, r.y);
    var c2 = conv(r.x + r.w, r.y);
    var c3 = conv(r.x, r.y + r.h);
    var c4 = conv(r.x + r.w, r.y + r.h);
    var x0 = Math.min(c1.x, c2.x, c3.x, c4.x);
    var y0 = Math.min(c1.y, c2.y, c3.y, c4.y);
    var x1 = Math.max(c1.x, c2.x, c3.x, c4.x);
    var y1 = Math.max(c1.y, c2.y, c3.y, c4.y);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function flatten() {
    if (!state.pdfLibDoc) return Promise.reject(new Error('no doc'));
    status('Preparing your PDF…');
    var lib = state.pdfLibDoc;
    var fonts = {};
    function getFont(name) {
      if (!fonts[name]) {
        var fm = FONT_MAP[name] || FONT_MAP['Helvetica'];
        fonts[name] = lib.embedFont(fm.lib);
      }
      return fonts[name];
    }

    // Embed all images/signatures first so drawing stays synchronous.
    var embeds = [];
    state.annotations.forEach(function (a) {
      if ((a.type === 'image' || a.type === 'signature') && a.bytes && !a.embedded) {
        var isJpg = /jpg|jpeg/i.test(a.ext || '');
        embeds.push(
          (isJpg ? lib.embedJpg(a.bytes) : lib.embedPng(a.bytes)).then(function (img) { a.embedded = img; })
        );
      }
    });

    var chain = Promise.all(embeds).then(function () {
      return Promise.resolve();
    });

    state.pages.forEach(function (pageObj, i) {
      chain = chain.then(function () {
        var page = lib.getPage(i);
        if (!page) return;
        var rot = page.getRotation().angle;
        var W = page.getWidth(), H = page.getHeight();
        var VW = pageObj.baseW, VH = pageObj.baseH;
        var conv = function (x, y) { return viewToMedia(x, y, VW, VH, rot, W, H); };

        pageObj.anns.forEach(function (a) {
          try {
            switch (a.type) {
              case 'text': {
                var font = getFont(a.font);
                var lines = (a.text || '').split('\n');
                var lh = a.size * 1.25;
                lines.forEach(function (ln, li) {
                  var p = conv(a.x, a.y + li * lh);
                  page.drawText(ln, { x: p.x, y: p.y, size: a.size, font: font, color: hexToRgb(a.color) });
                });
                break;
              }
              case 'draw': {
                var rgb = hexToRgb(a.color);
                a.segs.forEach(function (s) {
                  var p1 = conv(s.x1, s.y1), p2 = conv(s.x2, s.y2);
                  page.drawLine({ start: { x: p1.x, y: p1.y }, end: { x: p2.x, y: p2.y }, thickness: a.width, color: rgb });
                });
                break;
              }
              case 'highlight': {
                var r = rectToMedia(a, VW, VH, rot, W, H);
                page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: hexToRgb(a.color), opacity: 0.4 });
                break;
              }
              case 'rect': {
                var r2 = rectToMedia(a, VW, VH, rot, W, H);
                page.drawRectangle({
                  x: r2.x, y: r2.y, width: r2.w, height: r2.h,
                  color: hexToRgb(a.color), opacity: a.fillOpacity,
                  borderColor: hexToRgb(a.color), borderWidth: a.width,
                });
                break;
              }
              case 'ellipse': {
                var r3 = rectToMedia(a, VW, VH, rot, W, H);
                var c = conv(a.x + a.w / 2, a.y + a.h / 2);
                page.drawEllipse({
                  x: c.x, y: c.y, xScale: r3.w / 2, yScale: r3.h / 2,
                  color: hexToRgb(a.color), opacity: a.fillOpacity,
                  borderColor: hexToRgb(a.color), borderWidth: a.width,
                });
                break;
              }
              case 'line': {
                var r1 = conv(a.x1, a.y1), r2l = conv(a.x2, a.y2);
                page.drawLine({ start: { x: r1.x, y: r1.y }, end: { x: r2l.x, y: r2l.y }, thickness: a.width, color: hexToRgb(a.color) });
                break;
              }
              case 'arrow': {
                var s1 = conv(a.x1, a.y1), s2 = conv(a.x2, a.y2);
                var ac = hexToRgb(a.color);
                page.drawLine({ start: { x: s1.x, y: s1.y }, end: { x: s2.x, y: s2.y }, thickness: a.width, color: ac });
                var ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);
                var head = Math.max(9, a.width * 3.5);
                page.drawLine({ start: { x: s2.x, y: s2.y }, end: { x: s2.x - head * Math.cos(ang - 0.42), y: s2.y - head * Math.sin(ang - 0.42) }, thickness: a.width, color: ac });
                page.drawLine({ start: { x: s2.x, y: s2.y }, end: { x: s2.x - head * Math.cos(ang + 0.42), y: s2.y - head * Math.sin(ang + 0.42) }, thickness: a.width, color: ac });
                break;
              }
              case 'note': {
                var r4 = rectToMedia({ x: a.x, y: a.y, w: 110, h: 110 }, VW, VH, rot, W, H);
                page.drawRectangle({ x: r4.x, y: r4.y, width: r4.w, height: r4.h, color: hexToRgb(a.color), opacity: 0.92 });
                break;
              }
              case 'image':
              case 'signature': {
                if (!a.embedded) return;
                var r5 = rectToMedia(a, VW, VH, rot, W, H);
                page.drawImage(a.embedded, { x: r5.x, y: r5.y, width: r5.w, height: r5.h });
                break;
              }
              case 'replace': {
                var f2 = getFont(a.font);
                a.rects.forEach(function (r) {
                  var rr = rectToMedia(r, VW, VH, rot, W, H);
                  page.drawRectangle({ x: rr.x, y: rr.y, width: rr.w, height: rr.h, color: PDFLib.rgb(1, 1, 1) });
                });
                var rp2 = conv(a.x, a.y);
                var size = a.size;
                var width = (a.text || '').length ? f2.widthOfTextAtSize(a.text, size) : 0;
                var maxW = W - rp2.x - 4;
                if (width > maxW && width > 0) size = size * (maxW / width);
                page.drawText(a.text, { x: rp2.x, y: rp2.y, size: size, font: f2, color: hexToRgb(a.color) });
                break;
              }
            }
          } catch (err) {
            console.warn('Failed to flatten annotation', a.type, err);
          }
        });
      });
    });

    return chain.then(function () {
      return lib.save({ useObjectStreams: false });
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var name = state.fileName.replace(/\.pdf$/i, '');
      a.href = url;
      a.download = name + '-edited.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      status('');
      toast('Downloaded ' + a.download);
    }).catch(function (err) {
      console.error(err);
      toast('Could not build the PDF for download.', true);
      status('');
    });
  }

  /* ------------------------------------------------------------------ */
  /* page list UI                                                       */
  /* ------------------------------------------------------------------ */
  function renderPageList() {
    var list = $('page-list');
    list.innerHTML = '';
    state.pages.forEach(function (pageObj, i) {
      var row = document.createElement('div');
      row.className = 'page-item';
      row.innerHTML =
        '<span class="pg-num">' + (i + 1) + '</span>' +
        '<span class="pg-spacer"></span>' +
        '<button class="pg-btn" data-act="left" title="Move left">◀</button>' +
        '<button class="pg-btn" data-act="right" title="Move right">▶</button>' +
        '<button class="pg-btn" data-act="rotate" title="Rotate">⟳</button>' +
        '<button class="pg-btn" data-act="dup" title="Duplicate">⧉</button>' +
        '<button class="pg-btn danger" data-act="del" title="Delete">✕</button>';
      row.addEventListener('click', function (e) {
        if (e.target === row || e.target.classList.contains('pg-spacer') || e.target.classList.contains('pg-num')) {
          pageObj.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      Array.prototype.forEach.call(row.querySelectorAll('.pg-btn'), function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = btn.dataset.act;
          if (act === 'left') opPage('move', i, i - 1);
          else if (act === 'right') opPage('move', i, i + 2);
          else if (act === 'rotate') opPage('rotate', i);
          else if (act === 'dup') opPage('duplicate', i);
          else if (act === 'del') opPage('delete', i);
        });
      });
      list.appendChild(row);
    });
    var addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm';
    addBtn.textContent = '+ Add blank page';
    addBtn.style.marginTop = '8px';
    addBtn.addEventListener('click', function () { opPage('add', state.pages.length); });
    list.appendChild(addBtn);
  }

  function opPage(type, index, to) {
    applyPageOp({ type: type, index: index, to: to }).catch(function (err) {
      console.error(err);
      toast('Page operation failed.', true);
    });
  }

  /* ------------------------------------------------------------------ */
  /* tools & UI wiring                                                  */
  /* ------------------------------------------------------------------ */
  function setTool(tool) {
    state.tool = tool;
    Array.prototype.forEach.call(document.querySelectorAll('.tool'), function (b) {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    var container = $('ed-pages');
    container.classList.remove('tool-draw', 'tool-text', 'tool-highlight', 'tool-pages');
    if (tool === 'draw') container.classList.add('tool-draw');
    else if (tool === 'text') container.classList.add('tool-text');
    else if (tool === 'highlight') container.classList.add('tool-highlight');
    else if (tool === 'pages') container.classList.add('tool-pages');

    // property panel visibility
    var show = { stroke: 0, fill: 0, text: 0 };
    if (tool === 'draw' || tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse') show.stroke = 1;
    if (tool === 'rect' || tool === 'ellipse') show.fill = 1;
    if (tool === 'text' || tool === 'replace') { show.text = 1; show.stroke = 1; }
    if (tool === 'highlight') show.fill = 1;
    if (tool === 'note') show.fill = 1;
    Array.prototype.forEach.call(document.querySelectorAll('.prop-row[data-show]'), function (row) {
      var key = row.dataset.show;
      row.style.display = show[key] ? '' : 'none';
    });

    var hints = {
      select: 'Click an annotation to select it, then drag to move. Press Delete to remove.',
      text: 'Click anywhere to add text, or click existing text to edit it.',
      replace: 'Use the Find & Replace panel on the right to rewrite existing text.',
      draw: 'Draw freehand. Adjust color and width in Properties.',
      highlight: 'Drag across text to highlight it.',
      rect: 'Drag to draw a rectangle.',
      ellipse: 'Drag to draw an ellipse.',
      line: 'Drag to draw a line.',
      arrow: 'Drag to draw an arrow.',
      note: 'Click to drop a sticky note.',
      image: 'Choose an image file — it will be inserted on the visible page.',
      signature: 'Create a typed, drawn, or uploaded signature and drop it on the page.',
      pages: 'Manage pages from the right panel.',
      delete: 'Click any annotation to delete it.',
    };
    $('panel-hint').textContent = hints[tool] || '';
    if (tool === 'image') $('file-input').click();
    if (tool === 'signature') $('sig-modal').classList.remove('hidden');
    if (tool === 'pages') renderPageList();
  }

  function init() {
    /* tools */
    Array.prototype.forEach.call(document.querySelectorAll('.tool'), function (b) {
      b.addEventListener('click', function () { setTool(b.dataset.tool); });
    });

    /* file inputs */
    $('btn-reupload').addEventListener('click', function () { $('file-input').click(); });
    $('btn-empty-upload').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadFromInput(f);
      e.target.value = '';
    });

    /* drag & drop onto canvas area */
    var dropArea = $('ed-canvas-area');
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropArea.addEventListener(evt, function (e) { e.preventDefault(); });
    });
    dropArea.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFromInput(f);
    });

    /* download */
    $('btn-download').addEventListener('click', function () { flatten(); });

    /* zoom */
    $('zoom-in').addEventListener('click', function () { setZoom(state.zoom + 0.25); });
    $('zoom-out').addEventListener('click', function () { setZoom(state.zoom - 0.25); });
    $('zoom-fit').addEventListener('click', function () { fitWidth(true); });

    /* properties */
    $('prop-color').addEventListener('input', function (e) { state.props.color = e.target.value; });
    $('prop-width').addEventListener('input', function (e) {
      state.props.width = parseFloat(e.target.value);
      $('prop-width-val').textContent = state.props.width + ' pt';
    });
    $('prop-opacity').addEventListener('input', function (e) {
      state.props.opacity = parseInt(e.target.value, 10) / 100;
      $('prop-opacity-val').textContent = e.target.value + '%';
    });
    $('prop-font').addEventListener('change', function (e) { state.props.font = e.target.value; });
    $('prop-size').addEventListener('input', function (e) {
      state.props.size = parseInt(e.target.value, 10);
      $('prop-size-val').textContent = state.props.size + ' pt';
    });

    /* find & replace */
    $('btn-find').addEventListener('click', function () { findText($('find-text').value); });
    $('find-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') findText($('find-text').value);
    });
    $('btn-replace').addEventListener('click', replaceOne);
    $('btn-replace-all').addEventListener('click', replaceAll);

    /* text popover */
    $('text-popover-ok').addEventListener('click', commitTextPopover);
    $('text-popover-cancel').addEventListener('click', function () {
      $('text-popover').classList.add('hidden');
    });
    $('text-popover-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTextPopover(); }
      if (e.key === 'Escape') $('text-popover').classList.add('hidden');
    });
    document.addEventListener('click', function (e) {
      var pop = $('text-popover');
      if (!pop.classList.contains('hidden') && !pop.contains(e.target)) {
        pop.classList.add('hidden');
      }
    });

    /* signature modal */
    initSignatureModal();
    $('sig-type-input').addEventListener('input', function () { if (window._redrawSig) window._redrawSig(); });
    $('sig-font-size').addEventListener('input', function () { if (window._redrawSig) window._redrawSig(); });

    /* keyboard shortcuts */
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      var map = { v: 'select', t: 'text', d: 'draw', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', n: 'note', s: 'signature', i: 'image' };
      var k = e.key.toLowerCase();
      if (map[k] && !e.ctrlKey && !e.metaKey && !e.altKey) { setTool(map[k]); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedId) {
          var ann = state.annotations.find(function (a) { return a.id === state.selectedId; });
          if (ann) { removeAnnotation(ann); state.selectedId = null; }
        }
      }
      if (e.key === 'Escape') {
        state.selectedId = null;
        state.pages.forEach(drawAnnotations);
        $('sig-modal').classList.add('hidden');
        $('text-popover').classList.add('hidden');
      }
    });

    /* load file handed over from the landing page */
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    if (id) {
      window.PdfFiles.getFile(id).then(function (file) {
        if (file) loadFromInput(file);
        else toast('The uploaded file could not be found.', true);
      }).catch(function () { toast('The uploaded file could not be found.', true); });
    }

    setTool('select');
  }

  // Expose pure helpers for testing/debugging (no DOM access at module level).
  window.PDFEditor = {
    viewToMedia: viewToMedia,
    rectToMedia: rectToMedia,
    rotateAnnotations: rotateAnnotations,
    state: state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
