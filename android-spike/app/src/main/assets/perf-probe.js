// Injected into whatever page the WebView has loaded (`--es perf 1`). Measures
// the two things a 10-foot UI lives or dies by, without a person in the loop:
//
//   scroll  — frame intervals while the biggest scroller moves for 5 s
//   focus   — time from moving focus to the frame that shows it, across the
//             page's real focusable elements
//
// Reported through console.log with the [r3-perf] prefix, which the spike
// activity forwards to logcat and its HUD.
(function () {
  function pct(sorted, p) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
  }
  function summarise(name, samples) {
    var s = samples.slice().sort(function (a, b) { return a - b })
    var slow = s.filter(function (v) { return v > 33.4 }).length
    return name + ' n=' + s.length + ' p50=' + pct(s, 0.5).toFixed(1) + 'ms p95=' + pct(s, 0.95).toFixed(1) +
      'ms max=' + (s[s.length - 1] || 0).toFixed(1) + 'ms >33ms=' + (s.length ? Math.round((100 * slow) / s.length) : 0) + '%'
  }
  function biggestScroller() {
    var best = document.scrollingElement, room = best ? best.scrollHeight - best.clientHeight : 0
    document.querySelectorAll('*').forEach(function (el) {
      var r = el.scrollHeight - el.clientHeight
      if (r > room && getComputedStyle(el).overflowY !== 'visible' && getComputedStyle(el).overflowY !== 'hidden') { best = el; room = r }
    })
    return { el: best, room: room }
  }

  function scrollTest(done) {
    var target = biggestScroller(), frames = [], last = performance.now(), start = last, dir = 1
    if (!target.el || target.room < 200) return done('scroll skipped (nothing scrollable, room=' + target.room + ')')
    function tick(now) {
      frames.push(now - last); last = now
      target.el.scrollTop += dir * 24
      if (target.el.scrollTop <= 0 || target.el.scrollTop >= target.room) dir = -dir
      if (now - start < 5000) requestAnimationFrame(tick)
      else done(summarise('scroll', frames.slice(2)))
    }
    requestAnimationFrame(tick)
  }

  function focusTest(done) {
    var all = Array.prototype.slice.call(document.querySelectorAll(
      'button,[role="button"],a[href],input,[tabindex]:not([tabindex="-1"])'))
      .filter(function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .slice(0, 60)
    if (all.length < 3) return done('focus skipped (only ' + all.length + ' focusable)')
    var samples = [], i = 0
    function next() {
      if (i >= all.length) return done(summarise('focus', samples) + ' of ' + all.length + ' elements')
      var t0 = performance.now()
      all[i++].focus({ preventScroll: false })
      // Two frames: the one that styles the change, and the one it is on screen by.
      requestAnimationFrame(function () { requestAnimationFrame(function () { samples.push(performance.now() - t0); next() }) })
    }
    next()
  }

  console.log('[r3-perf] starting: ' + document.querySelectorAll('*').length + ' DOM nodes, ' +
    document.images.length + ' images, viewport ' + innerWidth + 'x' + innerHeight + ' dpr ' + devicePixelRatio)
  scrollTest(function (scroll) {
    console.log('[r3-perf] ' + scroll)
    focusTest(function (focus) { console.log('[r3-perf] ' + focus) })
  })
})()
