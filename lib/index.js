/**
 * Host (Node) half of dsh-composer-phrases.
 *
 * The plugin is browser-only: its whole behavior lives in ./client.js, which the
 * shell loads into the page. This half exists so the profile loader can import a
 * node entry (package.json main / exports ".") and compose the plugin; it
 * deliberately provides no host-side behavior, injects no service, and opens no
 * network or filesystem access.
 */
export function apply() {}
