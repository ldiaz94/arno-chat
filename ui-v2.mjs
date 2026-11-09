import {CSS} from './theme.mjs';
import {CLIENT} from './client.mjs';
import {markdown,cleanOutput,diffHtml,tableResize} from './render.mjs';
import {SETTINGS_CLIENT} from './settings-client.mjs';

/** Static application shell. DOM IDs form the browser/controller contract.
 * No repository, model, or account text is interpolated into this document.
 * All untrusted content goes through the renderer or explicit escaping later.
 */
const BODY=String.raw`<div id="shell">
<div id="overlay" class="overlay">
</div>
<aside class="sidebar" aria-label="Sessions">
<div class="brand">
<div class="mark">a</div>
<b>arno chat</b>
<small>REMOTE</small>
</div>
<button id="new-chat" class="primary" type="button">＋ New chat</button>
<button id="new-session" class="ghost">＋ New session</button>
<div class="eyebrow" style="padding:0 10px">Your sessions</div>
<nav id="session-list" class="session-list">
</nav>
<div class="sidebar-foot">
<button id="account-settings" class="account-trigger ghost" type="button" aria-label="Account settings">
<span id="account-avatar" class="avatar">a</span>
<span class="account-trigger-name">
<strong id="account">Connecting…</strong>
<small>Account & connections</small>
</span>
</button>
<button id="theme" class="ghost icon" aria-label="Toggle color theme">◐</button>
<a href="/auth/logout" aria-label="Sign out" class="caption">Exit</a>
</div>
</aside>
<section class="workspace">
<header class="topbar">
<button id="menu" class="ghost icon mobile-only" aria-label="Open sessions" aria-expanded="false">☰</button>
<div class="topbar-title">
<strong id="title">Your workspace</strong>
<small id="subtitle">Connecting…</small>
</div>
<div id="workspace-pill" class="pill" hidden>
<span class="dot">
</span>
<span id="workspace-label">Workspace saved</span>
</div>
<button id="publish" class="ghost icon" aria-label="Review and publish" title="Review and publish">↗</button>
<button id="code" class="ghost icon" aria-label="Browse code and changes" title="Browse code and changes">⌘</button>
<button id="actions" class="ghost icon" aria-label="Session actions" title="Session actions">⋯</button>
<button id="export" class="ghost icon" aria-label="Export conversation" title="Export conversation">↧</button>
<button id="usage" class="ghost icon" aria-label="Usage and session details" title="Usage and session details">▥</button>
</header>
<main id="main" tabindex="-1">
<div class="loading">
<div class="skeleton">
</div>
<div class="skeleton" style="width:65%">
</div>
<p>Opening your workspace…</p>
</div>
</main>
<div id="composer-wrap" class="composer-wrap" hidden>
<form id="composer" class="composer">
<textarea id="prompt" rows="1" maxlength="8000" placeholder="Ask Arno to build, fix, or explain…" aria-label="Message">
</textarea>
<div class="composer-actions">
<button id="model-button" class="ghost model-button" type="button" aria-label="Change model">
</button>
<button id="stop" class="ghost" type="button" hidden>Stop</button>
<button id="send" class="primary" type="submit">↑ Send</button>
</div>
</form>
<div class="composer-hint">⌘ / Ctrl + Enter to send · ⌘ / Ctrl + K to switch model · Changes are saved after each turn</div>
</div>
</section>
</div>
<dialog id="model-dialog" class="modal" aria-labelledby="model-heading">
<div class="modal-head">
<h2 id="model-heading">Choose your model</h2>
<button data-close class="ghost icon" aria-label="Close models">×</button>
</div>
<div class="modal-body">
<div class="searchbox">
<input id="model-search" placeholder="Search cloud models…" aria-label="Search models">
</div>
<div id="model-options" class="model-options">
</div>
<p class="caption">Changing models keeps your repository and conversation.</p>
</div>
</dialog>
<dialog id="usage-dialog" class="modal" aria-labelledby="usage-heading">
<div class="modal-head">
<h2 id="usage-heading">Usage & workspace</h2>
<button data-close class="ghost icon" aria-label="Close usage">×</button>
</div>
<div id="usage-body" class="modal-body">
</div>
</dialog>
<dialog id="account-dialog" class="modal account-dialog" aria-labelledby="account-heading">
<div class="modal-head">
<h2 id="account-heading">Your account</h2>
<button data-close class="ghost icon" aria-label="Close account settings">×</button>
</div>
<div id="account-body" class="modal-body">
</div>
</dialog>
<dialog id="actions-dialog" class="modal" aria-label="Session actions">
<div class="modal-head">
<h2>Session actions</h2>
<button data-close class="ghost icon" aria-label="Close actions">×</button>
</div>
<div id="action-items" class="modal-body">
<button id="rename-conversation" class="model-option" type="button">Rename conversation</button>
<button id="delete-conversation" class="model-option danger" type="button">Delete conversation</button>
</div>
</dialog>
<dialog id="code-dialog" class="modal code-dialog" aria-label="Code and changes">
<div class="modal-head">
<h2>Code & changes</h2>
<button data-close class="ghost icon" aria-label="Close code">×</button>
</div>
<div class="code-tabs">
<button id="files-tab">Files</button>
<button id="diff-tab">Changes</button>
</div>
<div id="code-body" class="code-body">
</div>
</dialog>
<dialog id="publish-dialog" class="modal" aria-labelledby="publish-heading">
<div class="modal-head">
<h2 id="publish-heading">Review & publish</h2>
<button data-close class="ghost icon" aria-label="Close publishing">×</button>
</div>
<div id="publish-body" class="modal-body">
</div>
</dialog>
<dialog id="sources-dialog" class="modal" aria-labelledby="sources-heading">
<div class="modal-head">
<h2 id="sources-heading">Sources & citations</h2>
<button data-close class="ghost icon" aria-label="Close sources">×</button>
</div>
<div id="sources-body" class="modal-body">
</div>
</dialog>
<dialog id="conversation-dialog" class="modal" aria-labelledby="conversation-menu-heading">
<div class="modal-head">
<h2 id="conversation-menu-heading">Conversation</h2>
<button data-close class="ghost icon" aria-label="Close conversation menu">×</button>
</div>
<div class="modal-body">
<button id="list-rename" class="model-option" type="button">Rename</button>
<button id="list-delete" class="model-option danger" type="button">Delete conversation</button>
</div>
</dialog>
<div id="toast" class="toast" role="status" hidden>
</div>`;

/** Ship a self-contained document without third-party fonts or script CDNs.
 * Serializing the tested renderer functions keeps browser and Node behavior
 * identical. Upstream logo/mascot resources are served from our own origin.
 */
export const HTML='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0d1117"><link rel="icon" href="/brand/logo.svg"><title>Arno · Chat & coding</title><style>'+CSS+'</style></head><body>'+BODY+
 '<script type="module">const markdown='+markdown.toString()+';const cleanOutput='+cleanOutput.toString()+';const diffHtml='+diffHtml.toString()+';const tableResize='+tableResize.toString()+';tableResize(document);'+CLIENT+SETTINGS_CLIENT+'</script></body></html>';
