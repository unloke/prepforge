function T({appState:o,api:u,escapeHtml:i,hideTeamDetail:d,openTeamDetail:c,loadSharedRepertoires:y,editRepertoire:p,unshareRepertoireFromTeam:f,copySharedRepertoire:b,teamRoleLabel:h}){function v(s){const t=Number(s)||0;return`${t} member${t===1?"":"s"}`}async function L(){const s=document.getElementById("teams-list"),t=document.getElementById("teams-shared");if(s){if(!o.signedIn){s.innerHTML='<div class="empty-state">Sign in to create and join teams.</div>',t&&(t.innerHTML=""),d();return}s.innerHTML='<div class="empty-state">Loading…</div>';try{const n=await u("/api/teams");o.teams=n.teams||[],l(),o.selectedTeamId&&o.teams.some(e=>e.id===o.selectedTeamId)?c(o.selectedTeamId):d()}catch(n){s.innerHTML=`<div class="empty-state">${i(n.message)}</div>`}y()}}function l(){const s=document.getElementById("teams-list");if(s){if(!o.teams.length){s.innerHTML='<div class="empty-state">No teams yet. Create one to start sharing.</div>';return}s.innerHTML=o.teams.map(t=>{const n=i(t.id),e=i(t.name),a=i(h(t.role)),r=i(v(t.member_count));return`
        <div class="list-item team-row${o.selectedTeamId===t.id?" is-selected":""}" role="button" tabindex="0" data-team-id="${n}">
          <span>
            <span class="name">${e}</span>
            <span class="sub"> · ${r}</span>
          </span>
          <span class="team-role-badge">${a}</span>
        </div>`}).join(""),s.querySelectorAll(".team-row").forEach(t=>{const n=()=>c(t.dataset.teamId);t.addEventListener("click",n),t.addEventListener("keydown",e=>{(e.key==="Enter"||e.key===" ")&&(e.preventDefault(),n())})})}}function g(s,t){const n=document.getElementById("team-shared-repertoires");if(n){if(!t.length){n.innerHTML='<div class="empty-state">No repertoires shared yet. Use “Share a repertoire” above to add one.</div>';return}n.innerHTML=t.map(e=>{const a=i(e.id),r=i(e.name),m=i(e.color),E=i(e.owner_display_name||e.owner_email||"member"),$=e.owner_user_id===o.accountUserId?`<button type="button" class="ib team-unshare" data-rep-id="${a}" data-rep-name="${r}" title="Stop sharing">Unshare</button>`:`<button type="button" class="ib team-copy" data-rep-id="${a}" title="Copy to my account">Copy</button>`;return`
        <div class="list-item team-shared-rep-row" role="button" tabindex="0" data-repertoire-id="${a}">
          <span>
            <span class="color-dot ${m}"></span>
            <span class="name">${r}</span>
            <span class="sub"> · ${E}</span>
          </span>
          <span class="team-member-tail">${$}</span>
        </div>`}).join(""),n.querySelectorAll(".team-shared-rep-row").forEach(e=>{const a=()=>p(e.dataset.repertoireId);e.addEventListener("click",r=>{r.target.closest(".team-unshare")||r.target.closest(".team-copy")||a()}),e.addEventListener("keydown",r=>{(r.key==="Enter"||r.key===" ")&&(r.preventDefault(),a())})}),n.querySelectorAll(".team-unshare").forEach(e=>{e.addEventListener("click",a=>{a.stopPropagation(),f(s,e.dataset.repId,e.dataset.repName)})}),n.querySelectorAll(".team-copy").forEach(e=>{e.addEventListener("click",a=>{a.stopPropagation(),b(e.dataset.repId)})})}}return{loadTeams:L,renderTeamsList:l,renderTeamSharedRepertoires:g}}export{T as createTeamsView};
