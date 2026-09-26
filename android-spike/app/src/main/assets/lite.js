// Injected with `--es lite 1`: the page as the TV skin would make it — no
// backdrop blur, no ambient animation, no transitions — so the same probe can
// be run both ways and the difference read off as a number.
(function () {
  var style = document.createElement('style')
  style.textContent =
    '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
    'animation:none!important;transition:none!important}'
  document.head.appendChild(style)
  console.log('[r3-perf] lite css applied')
})()
