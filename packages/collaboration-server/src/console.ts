export interface CollaborationConsoleAsset {
  readonly body: string
  readonly contentType: 'text/html; charset=utf-8' | 'text/css; charset=utf-8' | 'text/javascript; charset=utf-8'
}

const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="SciForge A 云端协同控制面最小运维控制台">
  <meta name="theme-color" content="#15382d">
  <title>SciForge · 协同控制塔</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <a class="skip-link" href="#workspace">跳到操作区</a>
  <header class="masthead">
    <div class="brand-block">
      <span class="eyebrow">SCIFORGE / CONTROL PLANE A</span>
      <h1>协同控制塔</h1>
      <p>项目、任务、信箱与共享记录的权威台账</p>
    </div>
    <div class="system-strip" aria-label="控制台状态">
      <span class="signal" aria-hidden="true"></span>
      <span id="connection-label">尚未装载凭据</span>
      <span class="version">协议 1.0</span>
    </div>
  </header>

  <div class="shell">
    <aside class="session-rail" aria-labelledby="session-title">
      <div class="rail-index">00</div>
      <h2 id="session-title">连接与身份</h2>
      <p class="aside-copy">请求固定发送到当前来源的 <code>/v1/commands</code>。Bearer 只保留在本页内存中，刷新即失效。</p>
      <dl class="connection-facts">
        <div><dt>服务来源</dt><dd id="service-origin">当前来源</dd></div>
        <div><dt>请求端点</dt><dd><code>/v1/commands</code></dd></div>
      </dl>
      <form id="session-form" class="stack-form">
        <label for="bearer-token">Bearer 凭据</label>
        <input id="bearer-token" name="bearerToken" type="password" autocomplete="off" spellcheck="false" required>
        <label for="actor-kind">当前身份类型</label>
        <select id="actor-kind" name="actorKind">
          <option value="user">User / 项目负责人</option>
          <option value="agent">Agent / Coordinator 或 Worker</option>
        </select>
        <label for="actor-id">当前 User / Agent ID（仅作界面标记）</label>
        <input id="actor-id" name="actorId" autocomplete="off" spellcheck="false" placeholder="usr_… 或 agt_…">
        <button class="button primary" type="submit">装载到内存</button>
        <button class="button quiet" id="disconnect-button" type="button">清除凭据</button>
      </form>
      <div class="session-state" role="status" aria-live="polite">
        <span>当前操作席位</span>
        <strong id="actor-label">未连接</strong>
      </div>
      <button class="button danger-line" id="revoke-credential" type="button">撤销当前应用凭据</button>
      <p class="microcopy">撤销成功后，本凭据立即失效。控制台不会显示、下载或保存令牌。</p>
    </aside>

    <main id="workspace" class="workspace">
      <section class="notice-board" aria-labelledby="boundary-title">
        <div>
          <span class="stamp">A-ONLY</span>
          <h2 id="boundary-title">这里是权威状态台账，不是 Agent 执行器</h2>
        </div>
        <p>控制台不运行任务、不读取本地文件、不实现 Coordinator 推理、Zulip 客户端或 OpenContent 正文。没有列表接口的实体必须使用已知 ID 查询。</p>
      </section>

      <section class="ledger-section" aria-labelledby="identity-title">
        <div class="section-heading"><span>01</span><div><h2 id="identity-title">身份核验</h2><p>确认当前 User 凭据对应的公开身份。</p></div></div>
        <form class="command-form compact" data-command="user-get">
          <label for="user-get-id">User ID</label>
          <input id="user-get-id" name="userId" required placeholder="usr_…" spellcheck="false">
          <button class="button" type="submit">读取 User</button>
        </form>
        <div class="result-panel" data-output="user-get" aria-live="polite"><p>等待查询。</p></div>
      </section>

      <section class="ledger-section" aria-labelledby="project-title">
        <div class="section-heading"><span>02</span><div><h2 id="project-title">Project 总账</h2><p>Owner 创建项目、读取权威快照并执行最终状态确认。</p></div></div>
        <div class="split-grid">
          <form class="command-form" data-command="project-create">
            <h3>创建 Project <em>Owner User</em></h3>
            <label for="project-owner">Owner User ID</label>
            <input id="project-owner" name="ownerUserId" required placeholder="usr_…" spellcheck="false">
            <label for="project-name">项目名称</label>
            <input id="project-name" name="displayName" required maxlength="200">
            <label for="project-goal">项目目标</label>
            <textarea id="project-goal" name="goal" required rows="3"></textarea>
            <label for="project-members">成员 User ID（逗号或换行分隔，必须包含 Owner）</label>
            <textarea id="project-members" name="memberUserIds" required rows="3" spellcheck="false" placeholder="usr_…&#10;usr_…"></textarea>
            <label for="project-coordinator">Coordinator Agent ID</label>
            <input id="project-coordinator" name="coordinatorAgentId" required placeholder="agt_…" spellcheck="false">
            <div class="number-grid">
              <label>任务上限<input name="maxTasks" type="number" value="20" min="1" max="10000" required></label>
              <label>每轮上限<input name="maxTasksPerRound" type="number" value="5" min="1" max="1000" required></label>
              <label>协同轮次<input name="maxCoordinationRounds" type="number" value="5" min="1" max="10000" required></label>
              <label>单任务重试<input name="maxTaskRetries" type="number" value="2" min="0" max="100" required></label>
            </div>
            <button class="button primary" type="submit">创建权威 Project</button>
          </form>

          <div class="form-stack">
            <form class="command-form" data-command="project-read">
              <h3>读取 Project / 能力目录 <em>Active member</em></h3>
              <label for="project-read-id">Project ID</label>
              <input id="project-read-id" name="projectId" required placeholder="prj_…" spellcheck="false">
              <div class="button-row">
                <button class="button" type="submit" name="operation" value="project.get">读取 Project</button>
                <button class="button" type="submit" name="operation" value="project.capability_directory.get">查询能力</button>
              </div>
            </form>
            <form class="command-form warning-form" data-command="project-transition">
              <h3>最终项目确认 <em>Owner User</em></h3>
              <p class="permission-note">完成或取消属于人类负责人确认；存在未结束 Task 时服务端会拒绝。</p>
              <label for="project-transition-id">Project ID</label>
              <input id="project-transition-id" name="projectId" required placeholder="prj_…" spellcheck="false">
              <label for="project-transition-revision">expectedRevision</label>
              <input id="project-transition-revision" name="expectedRevision" type="number" min="1" required>
              <label for="project-status">目标状态</label>
              <select id="project-status" name="status"><option value="completed">completed</option><option value="cancelled">cancelled</option></select>
              <button class="button danger-line" type="submit">确认项目状态</button>
            </form>
          </div>
        </div>
        <div class="result-panel" data-output="project" aria-live="polite"><p>Project 操作结果将在这里显示。</p></div>
      </section>

      <section class="ledger-section" aria-labelledby="task-title">
        <div class="section-heading"><span>03</span><div><h2 id="task-title">Task 路由台</h2><p>创建、查看、取消、重试或改派；权限与 revision 由服务端裁决。</p></div></div>
        <div class="three-grid">
          <form class="command-form" data-command="task-create">
            <h3>创建并路由 <em>Owner User 确认</em></h3>
            <label>Project ID<input name="projectId" required placeholder="prj_…" spellcheck="false"></label>
            <label>Project expectedRevision<input name="expectedRevision" type="number" min="1" required></label>
            <label>Assignee Agent ID<input name="assigneeAgentId" required placeholder="agt_…" spellcheck="false"></label>
            <label>任务标题<input name="title" required maxlength="200"></label>
            <label>任务目标<textarea name="objective" required rows="3"></textarea></label>
            <label>完成条件（逐行）<textarea name="completionCriteria" required rows="3"></textarea></label>
            <label>依赖 Task ID（逗号或换行，可空）<textarea name="dependencyTaskIds" rows="2" spellcheck="false"></textarea></label>
            <button class="button primary" type="submit">确认创建 Task</button>
          </form>

          <div class="form-stack">
            <form class="command-form" data-command="task-get">
              <h3>读取 Task <em>Active member</em></h3>
              <label>Task ID<input name="taskId" required placeholder="tsk_…" spellcheck="false"></label>
              <button class="button" type="submit">查看进度与结果</button>
            </form>
            <form class="command-form warning-form" data-command="task-cancel">
              <h3>取消 Task <em>Owner User</em></h3>
              <label>Task ID<input name="taskId" required placeholder="tsk_…" spellcheck="false"></label>
              <label>Task expectedRevision<input name="expectedRevision" type="number" min="1" required></label>
              <button class="button danger-line" type="submit">确认取消</button>
            </form>
          </div>

          <form class="command-form" data-command="task-retry">
            <h3>重试 / 改派</h3>
            <p class="permission-note">同一 assignee 重试仅接受 failed / rejected，可由 Owner User 或 Coordinator Agent 发起；更换 assignee 的主动改派仅限 Owner User。</p>
            <p class="microcopy">服务端根据目标 Agent 是否为当前 assignee 判定“重试”或“改派”；主动换人可用于掉线的 active Task。</p>
            <label>Task ID<input name="taskId" required placeholder="tsk_…" spellcheck="false"></label>
            <label>Task expectedRevision<input name="expectedRevision" type="number" min="1" required></label>
            <label>目标 Assignee Agent ID<input name="assigneeAgentId" required placeholder="agt_…" spellcheck="false"></label>
            <button class="button" type="submit">提交 task.retry</button>
          </form>
        </div>
        <div class="result-panel" data-output="task" aria-live="polite"><p>Task 的 status、progress、resultSummary 与冲突 revision 将显示在这里。</p></div>
      </section>

      <section class="ledger-section" aria-labelledby="inbox-title">
        <div class="section-heading"><span>04</span><div><h2 id="inbox-title">User 持久信箱</h2><p>按 sequence 拉取、检查 HumanNeeded，并逐条 ACK。</p></div></div>
        <div class="split-grid">
          <form class="command-form" data-command="inbox-pull">
            <h3>拉取 User Inbox <em>当前 User</em></h3>
            <input name="recipientType" type="hidden" value="user">
            <label>afterSequence<input name="afterSequence" type="number" min="0" value="0" required></label>
            <label>limit<input name="limit" type="number" min="1" max="1000" value="50" required></label>
            <button class="button" type="submit">拉取消息</button>
          </form>
          <form class="command-form" data-command="inbox-ack">
            <h3>确认消息 <em>消息接收者</em></h3>
            <label>Inbox Message ID<input name="inboxMessageId" required placeholder="ibx_…" spellcheck="false"></label>
            <label>sequence<input name="sequence" type="number" min="1" required></label>
            <button class="button" type="submit">ACK</button>
          </form>
        </div>
        <div class="result-panel inbox-output" data-output="inbox" aria-live="polite"><p>不会自动回答 HumanNeeded；答案仍须从已验证的人类入口进入。</p></div>
      </section>

      <section class="ledger-section" aria-labelledby="record-title">
        <div class="section-heading"><span>05</span><div><h2 id="record-title">共享记录与资源引用</h2><p>读取追加式 ProjectRecord 与元数据型 ResourceRef。</p></div></div>
        <div class="three-grid">
          <form class="command-form" data-command="record-get">
            <h3>读取 ProjectRecord <em>Active member</em></h3>
            <label>ProjectRecord ID<input name="projectRecordId" required placeholder="rec_…" spellcheck="false"></label>
            <button class="button" type="submit">读取记录</button>
          </form>
          <form class="command-form warning-form" data-command="record-accept">
            <h3>验收记录</h3>
            <p class="permission-note">决定类 / 总结类记录必须由 Owner User 验收；普通观察或任务结果按服务端权限执行。</p>
            <label>ProjectRecord ID<input name="projectRecordId" required placeholder="rec_…" spellcheck="false"></label>
            <label>expectedRevision<input name="expectedRevision" type="number" min="1" required></label>
            <label>决定<select name="decision"><option value="accepted">accepted</option><option value="rejected">rejected</option></select></label>
            <button class="button danger-line" type="submit">提交验收</button>
          </form>
          <form class="command-form" data-command="resource-get">
            <h3>读取 ResourceRef <em>Active member</em></h3>
            <label>ResourceRef ID<input name="resourceRefId" required placeholder="rrf_…" spellcheck="false"></label>
            <button class="button" type="submit">读取元数据引用</button>
          </form>
        </div>
        <div class="result-panel" data-output="record" aria-live="polite"><p>控制台只显示资源元数据，不接收正文、凭据、file:// 或本地绝对路径。</p></div>
      </section>

      <footer>
        <span>SciForge Collaboration Protocol 1.0</span>
        <span>每次写入都携带新的 requestId、idempotencyKey 与 Idempotency-Key 请求头</span>
      </footer>
    </main>
  </div>
  <script src="app.js" defer></script>
</body>
</html>
`

const CONSOLE_CSS = `:root {
  color-scheme: light;
  --ink: #17211b;
  --paper: #f1eddf;
  --paper-deep: #e5decb;
  --pine: #15382d;
  --pine-light: #285746;
  --rust: #bd4829;
  --signal: #f0b429;
  --line: #26352d;
  --muted: #62685f;
  --white: #fffdf5;
  --shadow: 8px 8px 0 rgba(21, 56, 45, .16);
  font-family: "Avenir Next", "PingFang SC", "Noto Sans CJK SC", sans-serif;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--ink);
  background-color: var(--paper);
  background-image: linear-gradient(rgba(23, 33, 27, .055) 1px, transparent 1px), linear-gradient(90deg, rgba(23, 33, 27, .055) 1px, transparent 1px);
  background-size: 24px 24px;
  min-width: 320px;
}
button, input, textarea, select { font: inherit; }
button { touch-action: manipulation; }
code, pre, input[spellcheck="false"], textarea[spellcheck="false"] { font-family: "SFMono-Regular", Consolas, monospace; }

.skip-link { position: fixed; top: 8px; left: 8px; transform: translateY(-160%); background: var(--signal); color: var(--ink); padding: 10px 14px; z-index: 100; font-weight: 800; }
.skip-link:focus { transform: translateY(0); }

.masthead {
  display: flex;
  justify-content: space-between;
  gap: 28px;
  align-items: flex-end;
  padding: 30px clamp(20px, 4vw, 64px) 24px;
  background: var(--pine);
  color: var(--white);
  border-bottom: 8px solid var(--rust);
}
.brand-block { position: relative; }
.brand-block::before { content: "A"; position: absolute; right: -68px; bottom: -12px; color: rgba(255,255,255,.07); font: 900 108px/1 Georgia, serif; }
.eyebrow { color: var(--signal); font-size: .72rem; font-weight: 900; letter-spacing: .2em; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin: 5px 0 2px; font: 700 clamp(2.1rem, 5vw, 4.6rem)/.95 "Songti SC", Georgia, serif; letter-spacing: -.045em; }
.brand-block p { margin: 10px 0 0; color: #cbd7ce; letter-spacing: .08em; }
.system-strip { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
.signal { width: 10px; height: 10px; border-radius: 50%; background: var(--signal); box-shadow: 0 0 0 4px rgba(240,180,41,.18); }
.version { border-left: 1px solid rgba(255,255,255,.25); padding-left: 10px; color: #b9c9bf; }

.shell { display: grid; grid-template-columns: minmax(270px, 330px) minmax(0, 1fr); align-items: start; }
.session-rail { position: sticky; top: 0; min-height: 100vh; padding: 34px 28px; background: var(--paper-deep); border-right: 2px solid var(--line); }
.rail-index { font: 900 3.2rem/1 Georgia, serif; color: var(--rust); border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.session-rail h2 { font: 700 1.6rem/1.1 "Songti SC", Georgia, serif; }
.aside-copy, .microcopy { color: var(--muted); font-size: .83rem; line-height: 1.65; }
.connection-facts { margin: 24px 0; border-block: 1px solid rgba(38,53,45,.35); }
.connection-facts div { padding: 10px 0; }
.connection-facts div + div { border-top: 1px dotted rgba(38,53,45,.35); }
.connection-facts dt { color: var(--muted); font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; }
.connection-facts dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: .85rem; }

.workspace { min-width: 0; padding: clamp(22px, 4vw, 58px); }
.notice-board { display: grid; grid-template-columns: minmax(240px, .85fr) minmax(280px, 1.15fr); gap: 30px; align-items: center; padding: 24px; background: var(--ink); color: var(--white); border-left: 12px solid var(--signal); box-shadow: var(--shadow); }
.notice-board h2 { margin: 7px 0 0; font: 700 clamp(1.4rem, 3vw, 2.2rem)/1.12 "Songti SC", Georgia, serif; }
.notice-board p { margin: 0; color: #ccd2ca; line-height: 1.7; }
.stamp { display: inline-block; padding: 3px 7px; color: var(--signal); border: 1px solid var(--signal); font: 900 .65rem/1 monospace; letter-spacing: .18em; transform: rotate(-1deg); }

.ledger-section { margin-top: 34px; padding: clamp(20px, 3vw, 34px); background: rgba(255,253,245,.9); border: 1px solid var(--line); box-shadow: var(--shadow); animation: rise .5s both; }
.ledger-section:nth-of-type(3) { animation-delay: .05s; }
.ledger-section:nth-of-type(4) { animation-delay: .1s; }
.ledger-section:nth-of-type(5) { animation-delay: .15s; }
.ledger-section:nth-of-type(6) { animation-delay: .2s; }
@keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.section-heading { display: flex; gap: 16px; align-items: flex-start; padding-bottom: 18px; margin-bottom: 22px; border-bottom: 3px double var(--line); }
.section-heading > span { min-width: 42px; color: var(--rust); font: 900 1.8rem/1 Georgia, serif; }
.section-heading h2 { margin-bottom: 4px; font: 700 clamp(1.35rem, 2.4vw, 2rem)/1.1 "Songti SC", Georgia, serif; }
.section-heading p { margin: 0; color: var(--muted); }
.split-grid, .three-grid { display: grid; gap: 20px; align-items: start; }
.split-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.three-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.form-stack { display: grid; gap: 20px; }

.stack-form, .command-form { display: grid; gap: 9px; }
.command-form { padding: 17px; border: 1px solid rgba(38,53,45,.45); background: rgba(241,237,223,.42); }
.command-form.compact { grid-template-columns: minmax(180px, 1fr) auto; align-items: end; }
.command-form.compact label { grid-column: 1 / -1; }
.command-form h3 { margin: 0 0 5px; font: 800 1rem/1.3 "Avenir Next", sans-serif; letter-spacing: .02em; }
.command-form h3 em { display: block; margin-top: 3px; color: var(--rust); font: 800 .66rem/1.2 "Avenir Next", sans-serif; text-transform: uppercase; letter-spacing: .12em; }
.warning-form { border-left: 5px solid var(--rust); }
label { display: grid; gap: 5px; color: #3d493f; font-size: .76rem; font-weight: 800; letter-spacing: .035em; }
input, textarea, select { width: 100%; color: var(--ink); background: var(--white); border: 1px solid #718077; border-radius: 0; padding: 9px 10px; }
textarea { resize: vertical; line-height: 1.5; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
.number-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
.button { min-height: 40px; padding: 9px 14px; border: 2px solid var(--pine); background: transparent; color: var(--pine); font-weight: 900; letter-spacing: .02em; cursor: pointer; transition: transform .15s ease, background .15s ease, color .15s ease; }
.button:hover { transform: translate(-2px, -2px); box-shadow: 3px 3px 0 var(--pine); }
.button:disabled { cursor: wait; opacity: .58; transform: none; box-shadow: none; }
.button.primary { background: var(--pine); color: var(--white); }
.button.quiet { border-width: 1px; }
.button.danger-line { border-color: var(--rust); color: #862f1a; }
.button.danger-line:hover { background: var(--rust); color: var(--white); box-shadow: 3px 3px 0 #6d2615; }
.permission-note { margin: 0 0 4px; color: var(--muted); font-size: .78rem; line-height: 1.5; }
.session-state { margin: 22px 0 12px; padding: 13px; background: var(--pine); color: var(--white); border-left: 6px solid var(--signal); }
.session-state span { display: block; color: #c1d0c7; font-size: .67rem; text-transform: uppercase; letter-spacing: .13em; }
.session-state strong { display: block; margin-top: 4px; overflow-wrap: anywhere; }

.result-panel { margin-top: 20px; min-height: 80px; padding: 16px; color: #d8e2db; background: #101713; border-top: 4px solid var(--pine-light); overflow: auto; }
.result-panel[data-state="error"] { border-top-color: var(--rust); }
.result-panel[data-state="success"] { border-top-color: #57a273; }
.result-panel p { margin: 0; color: #aab6ae; line-height: 1.55; }
.result-panel h4 { margin: 0 0 8px; color: var(--signal); font-size: .8rem; letter-spacing: .1em; text-transform: uppercase; }
.result-panel pre { margin: 0; color: #e6ece8; font-size: .78rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.result-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 10px; font: 700 .7rem/1.2 monospace; color: #91a098; }
.error-summary, .inbox-summary { margin-bottom: 10px; padding: 9px; }
.error-summary { color: #ffd8cc; border: 1px solid var(--rust); }
.inbox-summary { color: #d7f0df; border: 1px solid #57a273; }
footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; padding: 18px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: .72rem; }

@media (max-width: 1050px) {
  .shell { grid-template-columns: 1fr; }
  .session-rail { position: static; min-height: auto; border-right: 0; border-bottom: 2px solid var(--line); }
  .three-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .masthead { align-items: flex-start; flex-direction: column; }
  .brand-block::before { display: none; }
  .system-strip { justify-content: flex-start; }
  .workspace { padding-inline: 14px; }
  .notice-board, .split-grid, .three-grid { grid-template-columns: 1fr; }
  .command-form.compact { grid-template-columns: 1fr; }
  .command-form.compact label { grid-column: auto; }
  .number-grid { grid-template-columns: 1fr; }
  footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`

const CONSOLE_JS = `(() => {
  'use strict'

  const state = { token: '', actorKind: 'user', actorId: '' }
  const consolePath = new URL('.', globalThis.location.href).pathname
  const endpoint = consolePath.replace(/\\/console\\/$/u, '/v1/commands')

  const byId = (id) => document.getElementById(id)
  const asForm = (element) => {
    if (!(element instanceof HTMLFormElement)) throw new Error('Expected form element')
    return element
  }
  const value = (form, name) => {
    const field = form.elements.namedItem(name)
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
      throw new Error('Missing field: ' + name)
    }
    return field.value.trim()
  }
  const integerValue = (form, name) => Number.parseInt(value(form, name), 10)
  const splitIds = (raw) => raw.split(/[\\n,]+/u).map((item) => item.trim()).filter(Boolean)
  const lines = (raw) => raw.split(/\\n+/u).map((item) => item.trim()).filter(Boolean)

  function randomSuffix() {
    const bytes = new Uint8Array(18)
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes, (item) => item.toString(16).padStart(2, '0')).join('')
  }

  function envelope(type, write) {
    const body = { protocolVersion: '1.0', requestId: 'req_' + randomSuffix(), type }
    if (write) body.idempotencyKey = 'idem_console_' + randomSuffix()
    return body
  }

  function outputFor(name) {
    const output = document.querySelector('[data-output="' + name + '"]')
    if (!(output instanceof HTMLElement)) throw new Error('Missing output: ' + name)
    return output
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function appendTextNode(parent, tag, text, className) {
    const child = document.createElement(tag)
    child.textContent = text
    if (className) child.className = className
    parent.appendChild(child)
    return child
  }

  function renderPending(output, commandType) {
    clearNode(output)
    output.dataset.state = 'pending'
    appendTextNode(output, 'p', '正在提交 ' + commandType + ' …')
  }

  function renderResult(output, response, payload, durationMs) {
    clearNode(output)
    const isError = !response.ok || (payload && payload.type === 'rest.error')
    output.dataset.state = isError ? 'error' : 'success'
    appendTextNode(output, 'h4', isError ? '请求被拒绝' : '权威响应')
    const meta = document.createElement('div')
    meta.className = 'result-meta'
    appendTextNode(meta, 'span', 'HTTP ' + response.status)
    appendTextNode(meta, 'span', durationMs + ' ms')
    if (payload && typeof payload.requestId === 'string') appendTextNode(meta, 'span', payload.requestId)
    output.appendChild(meta)
    if (isError) {
      const error = payload && typeof payload.error === 'object' && payload.error ? payload.error : {}
      const code = typeof error.code === 'string' ? error.code : 'request_failed'
      const message = typeof error.message === 'string' ? error.message : '服务未返回结构化错误说明。'
      const revision = Number.isInteger(error.currentRevision) ? '；currentRevision=' + error.currentRevision : ''
      appendTextNode(output, 'div', code + '：' + message + revision, 'error-summary')
    }
    if (payload && payload.type === 'rest.inbox_page' && Array.isArray(payload.messages)) {
      const humanNeeded = payload.messages.filter((message) => message && message.payload && message.payload.type === 'human.needed').length
      appendTextNode(output, 'div', '消息 ' + payload.messages.length + ' 条；HumanNeeded ' + humanNeeded + ' 条。', 'inbox-summary')
    }
    const pre = appendTextNode(output, 'pre', JSON.stringify(payload, null, 2))
    pre.setAttribute('tabindex', '0')
  }

  function renderNetworkError(output, error) {
    clearNode(output)
    output.dataset.state = 'error'
    appendTextNode(output, 'h4', '网络或解析失败')
    appendTextNode(output, 'div', error instanceof Error ? error.message : '未知错误', 'error-summary')
  }

  async function send(command, outputName) {
    if (!state.token) {
      const output = outputFor(outputName)
      clearNode(output)
      output.dataset.state = 'error'
      appendTextNode(output, 'div', '请先在左侧装载 Bearer 凭据。', 'error-summary')
      return { ok: false, payload: null }
    }
    const output = outputFor(outputName)
    renderPending(output, command.type)
    const buttons = Array.from(document.querySelectorAll('button')).filter((item) => item instanceof HTMLButtonElement)
    buttons.forEach((button) => { button.disabled = true })
    const headers = { accept: 'application/json', authorization: 'Bearer ' + state.token, 'content-type': 'application/json' }
    if (typeof command.idempotencyKey === 'string') headers['Idempotency-Key'] = command.idempotencyKey
    const startedAt = performance.now()
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(command), credentials: 'same-origin' })
      let payload
      try { payload = await response.json() } catch { payload = { type: 'rest.error', error: { code: 'invalid_response', message: '响应不是 JSON。' } } }
      renderResult(output, response, payload, Math.round(performance.now() - startedAt))
      return { ok: response.ok && payload.type !== 'rest.error', payload }
    } catch (error) {
      renderNetworkError(output, error)
      return { ok: false, payload: null }
    } finally {
      buttons.forEach((button) => { button.disabled = false })
    }
  }

  function bindCommand(selector, outputName, build) {
    const form = asForm(document.querySelector(selector))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null
      void send(build(form, submitter), outputName)
    })
  }

  byId('service-origin').textContent = globalThis.location.origin
  asForm(byId('session-form')).addEventListener('submit', (event) => {
    event.preventDefault()
    const form = asForm(event.currentTarget)
    state.token = value(form, 'bearerToken')
    state.actorKind = value(form, 'actorKind')
    state.actorId = value(form, 'actorId')
    form.elements.namedItem('bearerToken').value = ''
    byId('connection-label').textContent = '凭据已装载（仅内存）'
    byId('actor-label').textContent = (state.actorKind === 'user' ? 'User' : 'Agent') + (state.actorId ? ' · ' + state.actorId : '')
  })
  byId('disconnect-button').addEventListener('click', () => {
    state.token = ''
    state.actorId = ''
    byId('connection-label').textContent = '尚未装载凭据'
    byId('actor-label').textContent = '未连接'
  })
  byId('revoke-credential').addEventListener('click', () => {
    if (!globalThis.confirm('确认撤销当前应用凭据？成功后该凭据立即失效。')) return
    void send(envelope('credential.revoke_current', true), 'user-get').then((result) => {
      if (!result.ok) return
      state.token = ''
      state.actorId = ''
      byId('connection-label').textContent = '凭据已撤销或请求已结束'
      byId('actor-label').textContent = '未连接'
    })
  })

  bindCommand('[data-command="user-get"]', 'user-get', (form) => ({ ...envelope('user.get', false), userId: value(form, 'userId') }))
  bindCommand('[data-command="project-create"]', 'project', (form) => ({
    ...envelope('project.create', true), ownerUserId: value(form, 'ownerUserId'), displayName: value(form, 'displayName'),
    goal: value(form, 'goal'), memberUserIds: splitIds(value(form, 'memberUserIds')),
    coordinatorAgentId: value(form, 'coordinatorAgentId'), budget: {
      maxTasks: integerValue(form, 'maxTasks'), maxTasksPerRound: integerValue(form, 'maxTasksPerRound'),
      maxCoordinationRounds: integerValue(form, 'maxCoordinationRounds'), maxTaskRetries: integerValue(form, 'maxTaskRetries')
    }
  }))
  bindCommand('[data-command="project-read"]', 'project', (form, submitter) => ({
    ...envelope(submitter && submitter.value === 'project.capability_directory.get' ? 'project.capability_directory.get' : 'project.get', false),
    projectId: value(form, 'projectId')
  }))
  bindCommand('[data-command="project-transition"]', 'project', (form) => ({
    ...envelope('project.transition', true), projectId: value(form, 'projectId'),
    expectedRevision: integerValue(form, 'expectedRevision'), status: value(form, 'status')
  }))
  bindCommand('[data-command="task-create"]', 'task', (form) => ({
    ...envelope('task.create', true), projectId: value(form, 'projectId'), expectedRevision: integerValue(form, 'expectedRevision'),
    assigneeAgentId: value(form, 'assigneeAgentId'), title: value(form, 'title'), objective: value(form, 'objective'),
    completionCriteria: lines(value(form, 'completionCriteria')), dependencyTaskIds: splitIds(value(form, 'dependencyTaskIds'))
  }))
  bindCommand('[data-command="task-get"]', 'task', (form) => ({ ...envelope('task.get', false), taskId: value(form, 'taskId') }))
  bindCommand('[data-command="task-cancel"]', 'task', (form) => ({
    ...envelope('task.transition', true), taskId: value(form, 'taskId'), expectedRevision: integerValue(form, 'expectedRevision'), status: 'cancelled'
  }))
  bindCommand('[data-command="task-retry"]', 'task', (form) => ({
    ...envelope('task.retry', true), taskId: value(form, 'taskId'), expectedRevision: integerValue(form, 'expectedRevision'),
    assigneeAgentId: value(form, 'assigneeAgentId')
  }))
  bindCommand('[data-command="inbox-pull"]', 'inbox', (form) => ({
    ...envelope('inbox.pull', false), recipientType: 'user', afterSequence: integerValue(form, 'afterSequence'), limit: integerValue(form, 'limit')
  }))
  bindCommand('[data-command="inbox-ack"]', 'inbox', (form) => ({
    ...envelope('inbox.ack', true), inboxMessageId: value(form, 'inboxMessageId'), sequence: integerValue(form, 'sequence')
  }))
  bindCommand('[data-command="record-get"]', 'record', (form) => ({
    ...envelope('project_record.get', false), projectRecordId: value(form, 'projectRecordId')
  }))
  bindCommand('[data-command="record-accept"]', 'record', (form) => ({
    ...envelope('project_record.accept', true), projectRecordId: value(form, 'projectRecordId'),
    expectedRevision: integerValue(form, 'expectedRevision'), decision: value(form, 'decision')
  }))
  bindCommand('[data-command="resource-get"]', 'record', (form) => ({
    ...envelope('resource.get', false), resourceRefId: value(form, 'resourceRefId')
  }))
})()
`

const ASSETS: Readonly<Record<string, CollaborationConsoleAsset>> = Object.freeze({
  '/console': Object.freeze({ body: CONSOLE_HTML, contentType: 'text/html; charset=utf-8' }),
  '/console/': Object.freeze({ body: CONSOLE_HTML, contentType: 'text/html; charset=utf-8' }),
  '/console/app.css': Object.freeze({ body: CONSOLE_CSS, contentType: 'text/css; charset=utf-8' }),
  '/console/app.js': Object.freeze({ body: CONSOLE_JS, contentType: 'text/javascript; charset=utf-8' })
})

export function getCollaborationConsoleAsset(path: string): CollaborationConsoleAsset | null {
  return ASSETS[path.split('?', 1)[0]!] ?? null
}
