// Time tab — the Chronogram fold-in: world clock, today's schedule of the
// present cast, long-term objectives. Read-only outside edit mode; in edit
// mode the clock can be set/nudged/locked, schedules cleared (the next
// post-pass rebuilds them) and objectives edited. Data and rules live in
// core/chrono.js; every change goes through the stateManager wrappers.
// Manual edits pass silent: true so they never pop notifications.

import { stateManager, playerNames } from "../core/stateManager.js";
import { chronoConfig, scheduleFor, nowNext, weekday, parseTimeHM } from "../core/chrono.js";
import { iconBtn } from "./characterView.js";

const SILENT = { silent: true };
let _optsOpen = false;

export function renderTimeTab(container, edit) {
    const d = stateManager.getData();
    const cfg = chronoConfig(d);
    renderClock(container, cfg, edit);
    if (cfg.schedules_on && cfg.clock) renderSchedules(container, d, cfg, edit);
    if (cfg.objectives_on) renderObjectives(container, cfg, edit);
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
    wrap.append(header("fa-solid fa-clock", "Clock", "The post-pass only adds the time that passed"));
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
                box("objectives_on", "Objectives", "Long-term goals of the player and the characters"),
            ),
            group("Injection",
                box("inject_clock", "Clock (high priority)", "Date and time in {{gamemaster-high-priority}}"),
                box("inject_schedules", "Day schedule (low priority)", "Today's plan in {{gamemaster-low-priority}} (changes on a new day or a real revision)", !cfg.schedules_on),
                box("inject_objectives", "Active objectives (low priority)", "Active objectives in {{gamemaster-low-priority}}", !cfg.objectives_on),
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

// ---------- objectives ----------

function renderObjectives(container, cfg, edit) {
    const wrap = $("<div>").addClass("gm_list gm_time_objectives");
    const head = header("fa-solid fa-flag", "Objectives", "Long-term goals with real stakes");
    if (edit) {
        const add = $("<div>").addClass("menu_button gm_add_btn").append($("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
        add.on("click", () => stateManager.addObjective({ title: `New objective ${cfg.objectives.length + 1}`, owner: "player" }, SILENT));
        head.append(add);
    }
    wrap.append(head);

    const active = cfg.objectives.filter(o => o.status === "active");
    const past = cfg.objectives.filter(o => o.status !== "active");
    const list = $("<div>").addClass("gm_entry_list");
    for (const o of active) list.append(edit ? objectiveEditor(o) : objectiveView(o));
    if (!active.length) list.append($("<div>").addClass("gm_empty").text("No active objectives."));
    wrap.append(list);

    if (past.length) {
        const hist = $("<details>").addClass("gm_bond_history").append($("<summary>").text(`Finished (${past.length})`));
        for (const o of past) {
            const row = $("<div>").addClass("gm_entry_desc gm_time_past_obj").append(
                $("<span>").text(`${o.title} — ${o.status === "completed" ? "completed" : "dropped"}`));
            if (edit) {
                row.append(
                    iconBtn("fa-solid fa-rotate-left").attr("title", "Make it active again").on("click", () => stateManager.setObjectiveStatus(o.id, "active", SILENT)),
                    iconBtn("fa-solid fa-trash").attr("title", "Delete").on("click", () => stateManager.removeObjective(o.id)),
                );
            }
            hist.append(row);
        }
        wrap.append(hist);
    }
    container.append(wrap);
}

function objectiveView(o) {
    const row = $("<div>").addClass("gm_entry_row gm_time_obj");
    const owner = stateManager.objectiveOwnerName(o);
    row.append($("<div>").addClass("gm_entry_top").append($("<div>").addClass("gm_entry_main").append(
        $("<b>").text(o.title),
        owner ? $("<span>").addClass("gm_entry_meta").text(owner) : null,
    )));
    if (o.description) row.append($("<div>").addClass("gm_entry_desc").text(o.description));
    const sub = [o.deadline ? `Deadline: ${o.deadline}` : "", o.steps ? `Steps: ${o.steps}` : "", o.progress ? `Progress: ${o.progress}` : ""].filter(Boolean);
    for (const line of sub) row.append($("<div>").addClass("gm_entry_desc gm_time_obj_sub").text(line));
    return row;
}

function objectiveEditor(o) {
    const row = $("<div>").addClass("gm_entry_row gm_time_obj gm_time_obj_edit");
    const field = (key, placeholder, value) => {
        const input = $("<input>").addClass("gm_input").attr({ placeholder, title: placeholder }).val(value ?? o[key] ?? "");
        input.on("change", () => stateManager.editObjective(o.id, { [key]: input.val() }));
        return input;
    };
    const actions = $("<div>").addClass("gm_entry_actions").append(
        iconBtn("fa-solid fa-check").attr("title", "Completed").on("click", () => stateManager.setObjectiveStatus(o.id, "completed", SILENT)),
        iconBtn("fa-solid fa-ban").attr("title", "Drop it").on("click", () => stateManager.setObjectiveStatus(o.id, "abandoned", SILENT)),
        iconBtn("fa-solid fa-trash").attr("title", "Delete").on("click", () => stateManager.removeObjective(o.id)),
    );
    row.append(
        $("<div>").addClass("gm_entry_top").append($("<div>").addClass("gm_entry_main").append(field("title", "Title")), actions),
        field("owner", "Owner (character or player)", stateManager.objectiveOwnerName(o)),
        field("description", "What must be done and why it matters"),
        field("deadline", "Deadline (optional)"),
        field("steps", "Steps (optional, A -> B -> C)"),
        field("progress", "Progress so far"),
    );
    return row;
}
