// Time tab — the Chronogram fold-in: world clock, today's schedule of the
// present cast, plans made in the story. Read-only outside edit mode; in edit
// mode the clock can be set/nudged/locked, schedules cleared (the next
// post-pass rebuilds them) and plans edited. Data and rules live in
// core/chrono.js; every change goes through the stateManager wrappers.
// Manual edits pass silent: true so they never pop notifications.

import { stateManager, playerNames } from "../core/stateManager.js";
import { chronoConfig, scheduleFor, nowNext, weekday, parseTimeHM, defaultChronoGuide, activePlans, planOverdue, planWhenText } from "../core/chrono.js";
import { iconBtn } from "./characterView.js";
import { openPromptEditor } from "./promptEditor.js";

const SILENT = { silent: true };
let _optsOpen = false;

export function renderTimeTab(container, edit) {
    const d = stateManager.getData();
    const cfg = chronoConfig(d);
    renderClock(container, cfg, edit);
    if (cfg.schedules_on && cfg.clock) renderSchedules(container, d, cfg, edit);
    if (cfg.plans_on) renderPlans(container, d, cfg, edit);
}

function header(icon, title, hint) {
    return $("<div>").addClass("gm_section_header").append(
        $("<b>").append($("<i>").addClass(icon), ` ${title}`),
        hint ? $("<span>").addClass("gm_section_hint").text(hint) : null,
    );
}

function smallBtn(icon, text, title) {
    return $("<div>").addClass("menu_button gm_small_btn").attr("title", title || text)
        .append(icon ? $("<i>").addClass(icon) : null, $("<span>").text(icon ? ` ${text}` : text));
}

// ---------- clock ----------

function renderClock(container, cfg, edit) {
    const wrap = $("<div>").addClass("gm_list gm_time_clock");
    const head = header("fa-solid fa-clock", "Clock", "The post-pass only adds the time that passed");
    if (edit) {
        const prompt = iconBtn("fa-solid fa-file-pen").addClass("gm_prompt_btn")
            .toggleClass("gm_prompt_custom", !!cfg.guide)
            .attr("title", `Edit the time guidance injected with the schedule/plans${cfg.guide ? " (custom)" : ""}`);
        prompt.on("click", () => openPromptEditor({
            title: "Time guidance",
            hint: "Instructions the story model reads at the top of the <chronogram> block (low priority, cached), above the day's schedule and the coming plans. Shown only when a schedule or plan is injected. A custom text is used as-is whichever modules are on.",
            placeholders: ["{{user}} = your persona's name"],
            value: cfg.guide,
            defaultText: defaultChronoGuide({ clock: cfg.inject_clock, schedules: cfg.schedules_on && cfg.inject_schedules, plans: cfg.plans_on && cfg.inject_plans }),
            onSave: text => stateManager.setChronoGuide(text),
        }));
        head.append(prompt);
    }
    wrap.append(head);
    if (cfg.clock) {
        wrap.append($("<div>").addClass("gm_time_now").append(
            $("<span>").addClass("gm_time_day").text(weekday(cfg.clock)),
            $("<span>").addClass("gm_time_date").text(cfg.clock.date),
            $("<span>").addClass("gm_time_hm").text(cfg.clock.time),
            cfg.locked ? $("<i>").addClass("fa-solid fa-lock gm_time_lock").attr("title", "Clock locked: the post-pass leaves it alone") : null,
        ));
    } else {
        wrap.append($("<div>").addClass("gm_empty").text("Clock not set yet — the next post-pass (or the Setup Wizard) sets it from the story."));
    }

    if (edit) {
        const date = $("<input>").addClass("gm_input gm_time_date_in").attr({ placeholder: "MM/DD/YYYY", title: "Date (MM/DD/YYYY)" }).val(cfg.clock?.date || "");
        const time = $("<input>").addClass("gm_input gm_time_hm_in").attr({ type: "time", title: "Time (24h)" }).val(cfg.clock?.time || "12:00");
        const set = smallBtn("fa-solid fa-check", "Set", "Set the clock to this date and time");
        set.on("click", () => {
            if (!stateManager.setClock(date.val(), time.val(), SILENT)) toastr.warning("Use a date like 04/12/1420 and a 24h time.");
        });
        wrap.append($("<div>").addClass("gm_time_set_row").append(date, time, set));

        if (cfg.clock) {
            const nudges = $("<div>").addClass("gm_time_nudges");
            for (const [label, mins] of [["+15m", 15], ["+1h", 60], ["+8h", 480], ["+1d", 1440]]) {
                nudges.append(smallBtn(null, label, `Advance the clock ${label.slice(1)}`)
                    .on("click", () => stateManager.advanceClock(mins, { ...SILENT, force: true })));
            }
            wrap.append(nudges);
        }

        // Every toggle re-renders the tab, so the open state lives outside the DOM.
        const opts = $("<details>").addClass("gm_time_opts").prop("open", _optsOpen)
            .on("toggle", () => { _optsOpen = opts.prop("open"); })
            .append($("<summary>").append($("<i>").addClass("fa-solid fa-sliders"), " Options"));
        const box = (key, text, title, disabled = false) => {
            const input = $("<input>").attr("type", "checkbox").prop({ checked: !!cfg[key], disabled })
                .on("change", () => stateManager.setChronoOptions({ [key]: input.prop("checked") }));
            return $("<label>").addClass("checkbox_label gm_time_opt").toggleClass("gm_time_opt_off", disabled)
                .attr("title", title || text).append(input, $("<span>").text(text));
        };
        const group = (title, ...rows) => $("<div>").addClass("gm_time_opt_group")
            .append($("<div>").addClass("gm_time_opt_title").text(title), ...rows);
        opts.append($("<div>").addClass("gm_time_opt_body").append(
            group("Clock",
                box("locked", "Lock the clock", "The post-pass stops moving the clock (manual changes still work)"),
            ),
            group("Tracking",
                box("schedules_on", "Daily schedules", "The post-pass writes a day plan"),
                box("schedules_party", "Schedules for the whole party", "Off: only the player keeps a schedule", !cfg.schedules_on),
                box("plans_on", "Plans", "Arrangements made in the story (a dinner on Sunday, a meeting at dawn)"),
            ),
            group("Injection",
                box("inject_clock", "Clock (high priority)", "Date and time in {{gamemaster-high-priority}}"),
                box("inject_schedules", "Day schedule (low priority)", "Today's schedule in {{gamemaster-low-priority}} (changes on a new day or a real revision)", !cfg.schedules_on),
                box("inject_plans", "Coming plans (low priority)", "Plans for the next 7 days (and undated ones) in {{gamemaster-low-priority}}", !cfg.plans_on),
            ),
        ));
        wrap.append(opts);
    }
    container.append(wrap);
}

// ---------- schedules ----------

function renderSchedules(container, d, cfg, edit) {
    const wrap = $("<div>").addClass("gm_list gm_time_schedules");
    wrap.append(header("fa-solid fa-calendar-day", "Today", cfg.schedules_party ? "What everyone present is up to" : "The player's day"));
    const nowMin = parseTimeHM(cfg.clock.time);
    for (const owner of stateManager.chronoOwners(playerNames())) {
        const entries = scheduleFor(d, owner.key, cfg.clock.date);
        const box = $("<div>").addClass("gm_entry_row gm_time_owner");
        const top = $("<div>").addClass("gm_entry_top").append($("<div>").addClass("gm_entry_main").append($("<b>").text(owner.name)));
        if (edit && entries.length) {
            const clear = iconBtn("fa-solid fa-rotate").attr("title", "Clear today's schedule (the next post-pass writes a new one)");
            clear.on("click", () => stateManager.clearSchedule(owner.key, cfg.clock.date));
            top.append($("<div>").addClass("gm_entry_actions").append(clear));
        }
        box.append(top);
        if (!entries.length) {
            box.append($("<div>").addClass("gm_entry_desc").text("No schedule for today yet."));
        } else {
            const { now } = nowNext(entries, cfg.clock.time);
            const list = $("<div>").addClass("gm_time_slots");
            for (const e of entries) {
                const t = parseTimeHM(e.time);
                list.append($("<div>").addClass("gm_time_slot")
                    .toggleClass("gm_time_slot_now", e === now)
                    .toggleClass("gm_time_slot_past", e !== now && nowMin !== null && t !== null && t < nowMin)
                    .append($("<span>").addClass("gm_time_slot_t").text(e.time), $("<span>").text(e.activity)));
            }
            box.append(list);
        }
        wrap.append(box);
    }
    container.append(wrap);
}

// ---------- plans ----------

const OUTCOME_LABEL = { kept: "kept", missed: "missed", cancelled: "cancelled" };

function renderPlans(container, d, cfg, edit) {
    const wrap = $("<div>").addClass("gm_list gm_time_plans");
    const head = header("fa-solid fa-calendar-check", "Plans", "Arrangements made in the story");
    if (edit) {
        const add = $("<div>").addClass("menu_button gm_add_btn").append($("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
        add.on("click", () => stateManager.addPlan({ title: `New plan ${cfg.plans.length + 1}`, date: cfg.clock?.date || "" }, SILENT));
        head.append(add);
    }
    wrap.append(head);

    const active = activePlans(d);
    const past = cfg.plans.filter(p => p.status !== "active");
    const list = $("<div>").addClass("gm_entry_list");
    for (const p of active) list.append(edit ? planEditor(p) : planView(p, cfg));
    if (!active.length) list.append($("<div>").addClass("gm_empty").text("No plans yet."));
    wrap.append(list);

    if (past.length) {
        const hist = $("<details>").addClass("gm_bond_history").append($("<summary>").text(`Past (${past.length})`));
        for (const p of past) {
            const row = $("<div>").addClass("gm_entry_desc gm_time_past_plan").append(
                $("<span>").text(`${p.title} — ${OUTCOME_LABEL[p.status] || p.status}`));
            if (edit) {
                row.append(
                    iconBtn("fa-solid fa-rotate-left").attr("title", "Make it active again").on("click", () => stateManager.resolvePlan(p.id, "active", SILENT)),
                    iconBtn("fa-solid fa-trash").attr("title", "Delete").on("click", () => stateManager.removePlan(p.id)),
                );
            }
            hist.append(row);
        }
        wrap.append(hist);
    }
    container.append(wrap);
}

function planView(p, cfg) {
    const row = $("<div>").addClass("gm_entry_row gm_time_plan");
    const overdue = planOverdue(p, cfg.clock);
    row.append($("<div>").addClass("gm_entry_top").append($("<div>").addClass("gm_entry_main").append(
        $("<b>").text(p.title),
        $("<span>").addClass("gm_entry_meta").toggleClass("gm_time_plan_overdue", overdue)
            .attr("title", overdue ? "Its time has passed — the next post-pass resolves it" : "")
            .text(planWhenText(p) || "No set day"),
    )));
    if (p.note) row.append($("<div>").addClass("gm_entry_desc").text(p.note));
    return row;
}

function planEditor(p) {
    const row = $("<div>").addClass("gm_entry_row gm_time_plan gm_time_plan_edit");
    const field = (key, placeholder) => {
        const input = $("<input>").addClass("gm_input").attr({ placeholder, title: placeholder }).val(p[key] ?? "");
        input.on("change", () => stateManager.editPlan(p.id, { [key]: input.val() }));
        return input;
    };
    const actions = $("<div>").addClass("gm_entry_actions").append(
        iconBtn("fa-solid fa-check").attr("title", "Kept (it happened)").on("click", () => stateManager.resolvePlan(p.id, "kept", SILENT)),
        iconBtn("fa-solid fa-user-clock").attr("title", "Missed").on("click", () => stateManager.resolvePlan(p.id, "missed", SILENT)),
        iconBtn("fa-solid fa-ban").attr("title", "Cancelled").on("click", () => stateManager.resolvePlan(p.id, "cancelled", SILENT)),
        iconBtn("fa-solid fa-trash").attr("title", "Delete").on("click", () => stateManager.removePlan(p.id)),
    );
    row.append(
        $("<div>").addClass("gm_entry_top").append($("<div>").addClass("gm_entry_main").append(field("title", "What, with whom, where")), actions),
        $("<div>").addClass("gm_time_plan_when").append(field("date", "Date MM/DD/YYYY (empty = no set day)"), field("time", "Time HH:MM (optional)")),
        field("note", "Note (optional)"),
    );
    return row;
}
