/**
 * Install the page fetched from a provider node into this document.
 *
 * Two things the plain innerHTML swap gets wrong, and both leave a blank page:
 *
 * 1. The page is served by a provider node but displayed under the domain, and
 *    the domain node does not hold the app's files. Every relative asset path
 *    in it therefore has to be resolved against the node that served it.
 * 2. Scripts inserted through innerHTML never execute, so they have to be
 *    re-created. Copying only their text drops "src" — an external script
 *    carries no text at all — so nothing runs. Copy the attributes as well and
 *    chain them, since dynamically inserted scripts otherwise race each other
 *    and a library can end up running after the code that needs it.
 */
window.LeitherInject = function (html, providerAddr, mid, ver) {
  var origin = "http://" + providerAddr + "/";
  // Read the app's files straight out of its Mimei. The node's root serves them
  // only where a route has been set for this app, which is per-node and easy to
  // miss; the mm path answers on every node holding the app.
  var assetBase = mid ? origin + "mm/" + mid + ":" + (ver || "last") + "/" : origin;
  var root = document.getElementById("LeitherHtml");
  var body = /<html\s*\S*>([\s|\S]*)<\/html>/i.exec(html);
  root.innerHTML = body ? body[1] : html;

  // Relative paths point at the domain, which has no copy of these files.
  // Absolute ones (another host) are already resolved and stay put.
  var resolve = function (value) {
    if (!value) return null;
    // A leading "/" would resolve to the node's root and lose the mm path, so
    // treat those as relative to the app as well.
    var path = value.charAt(0) === "/" && value.charAt(1) !== "/" ? value.slice(1) : value;
    try {
      return new URL(path, assetBase).href;
    } catch (err) {
      // Leave anything unparsable exactly as the page published it.
      return null;
    }
  };
  var toProvider = function (el, attr) {
    var resolved = resolve(el.getAttribute(attr));
    if (resolved) el.setAttribute(attr, resolved);
  };
  var links = root.querySelectorAll("link[href]");
  for (var j = 0; j < links.length; j++) toProvider(links[j], "href");

  var pending = [];
  var found = root.querySelectorAll("script");
  for (var k = 0; k < found.length; k++) pending.push(found[k]);

  var head = document.getElementsByTagName("head")[0];

  // Start every external fetch now, in parallel. The chain below still executes
  // them strictly in order — preloading only fills the cache, it never runs
  // anything — so an inline script that depends on an earlier library keeps
  // working, without paying a separate round trip to the node per script. The
  // hint has to match the real request's CORS mode and module-ness, or the
  // browser treats it as a different resource and fetches twice.
  for (var p = 0; p < pending.length; p++) {
    var href = resolve(pending[p].getAttribute("src"));
    if (!href) continue;
    var isModule = (pending[p].getAttribute("type") || "").toLowerCase() === "module";
    var hint = document.createElement("link");
    hint.rel = isModule ? "modulepreload" : "preload";
    if (!isModule) hint.as = "script";
    if (isModule || pending[p].hasAttribute("crossorigin")) {
      hint.crossOrigin = pending[p].getAttribute("crossorigin") || "anonymous";
    }
    hint.href = href;
    head.appendChild(hint);
  }
  var run = function (index) {
    if (index >= pending.length) return;
    var source = pending[index];
    var script = document.createElement("script");
    for (var a = 0; a < source.attributes.length; a++) {
      script.setAttribute(source.attributes[a].name, source.attributes[a].value);
    }
    toProvider(script, "src");
    script.textContent = source.textContent;
    if (script.src) {
      // Keep document order: run the next one only once this has loaded.
      script.async = false;
      script.onload = script.onerror = function () { run(index + 1); };
      head.appendChild(script);
    } else {
      head.appendChild(script);
      run(index + 1);
    }
  };
  run(0);
};
