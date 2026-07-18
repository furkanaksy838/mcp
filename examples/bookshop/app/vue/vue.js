/*

This is a simple wrapper using non-ESM Vue.js loaded in the browser via simple script tags,
instead of using importmaps, for example:

  <script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>

instead of:

  <script type="importmap">
    { "imports": {
      "vue": "https://cdn.jsdelivr.net/npm/vue@3/dist/vue.esm-browser.prod.js"
    } }
  </script>

*/

/* global Vue */
export const createApp = Vue.createApp;
export const reactive = Vue.reactive;
export const ref = Vue.ref;
