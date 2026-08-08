$path = 'C:\harel\RLAPP ON RL\ON TracK\assets\index.html'
$raw = Get-Content -LiteralPath $path -Raw

$newShell = @'
<div class="newShell">
  <aside class="newSidebar">
    <div class="railBrand">
      <div class="brandMark">O</div>
      <div>
        <div class="brandName">ON TracK</div>
        <div class="brandSub" data-i18n="subtitle">Workspace for model-driven projects</div>
      </div>
    </div>
    <div class="sideCard">
      <h3 data-i18n="sidebarProjects">Projects</h3>
      <button class="sideLink on"><span>ON TracK</span><span>●</span></button>
      <button class="sideLink"><span>Sandbox</span><span>○</span></button>
      <button class="sideLink"><span>Research</span><span>○</span></button>
    </div>
    <div class="sideCard">
      <h3 data-i18n="sidebarLibraries">Libraries</h3>
      <button class="sideLink on"><span>Project Docs</span><span>01</span></button>
      <button class="sideLink"><span>Design System</span><span>02</span></button>
      <button class="sideLink"><span>Shared Assets</span><span>03</span></button>
    </div>
  </aside>
  <main class="newMain">
    <div class="newTop">
      <div class="title" data-i18n="topTitle">Workspace</div>
      <div class="actions">
        <button class="miniBtn" id="newLangBtn">עברית / EN</button>
        <button class="miniBtn" id="newSettingsBtn" data-i18n="settingsBtn">הגדרות</button>
        <button class="miniBtn" id="newHelpBtn" data-i18n="helpBtn">עזרה</button>
        <button class="miniBtn" id="newGithubBtn" data-i18n="githubDockBtn">חיבור ל GitHub</button>
        <button class="miniBtn" id="newModelBtn" data-i18n="modelDockBtn">חיבור למודל</button>
      </div>
    </div>
    <div class="newContent">
      <section class="heroPanel">
        <h2 data-i18n="heroTitle">A clean workspace for model-driven projects</h2>
        <p data-i18n="heroText">This is the new MVP shell: choose a model, choose a project, define the task, and let the model perform controlled actions on repositories.</p>
        <div class="heroActions">
          <button class="add" id="heroStart" data-i18n="heroStart">Start new project</button>
          <button class="act" id="heroDocs" data-i18n="heroDocs">Open docs</button>
          <button class="act" id="heroConnect" data-i18n="heroConnect">Connect model</button>
        </div>
      </section>
      <section class="docPanel">
        <div class="docHeader">
          <div class="docTitle" data-i18n="docTitle">Project Info</div>
          <span class="hint">v0.2.0</span>
        </div>
        <div class="docBody" id="docBody">
          <ul>
            <li data-i18n="doc1">Step 1: choose language and layout.</li>
            <li data-i18n="doc2">Step 2: connect a model.</li>
            <li data-i18n="doc3">Step 3: connect a repository.</li>
            <li data-i18n="doc4">Step 4: let the model act on approved tasks.</li>
          </ul>
        </div>
      </section>
      <section class="chatPanel">
        <div class="chatBubble">
          <div class="meta">ON TracK</div>
          <div data-i18n="chatText">I want to build a system that receives a project, connects a model, and performs controlled actions on GitHub.</div>
        </div>
        <div class="composerBar">
          <button class="miniBtn">+</button>
          <input type="text" id="mainPrompt" placeholder="Write what you want the model to do..." />
          <button class="roundBtn">↑</button>
        </div>
      </section>
      <aside class="sideCard">
        <h3 data-i18n="quickStats">Quick Status</h3>
        <div class="heroStatRow"><span data-i18n="statusLabel">Status</span><b id="miniStatus">Fresh start</b></div>
        <div class="heroStatRow"><span data-i18n="versionLabel">Version</span><b>0.2.0</b></div>
        <div class="heroStatRow"><span data-i18n="langLabel">Language</span><b id="langLabel">Hebrew</b></div>
      </aside>
    </div>
  </main>
</div>
<div class="oldApp">
'@

$raw = [regex]::Replace($raw, '(?s)<div class="newShell">.*?<div class="oldApp">', $newShell)

Set-Content -LiteralPath $path -Value $raw -Encoding UTF8
