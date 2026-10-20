/**
 * Keeps a recording alive when another app asks Framecast to quit.
 *
 * macOS utilities with an "auto quit" feature quit apps shortly after their
 * last regular window closes. Framecast closes its Share window right as a
 * recording starts, which made such tools quit it mid-start. Quit requests
 * that come from Framecast's own menus are marked here and always go ahead;
 * any other request is refused while a recording is starting or running.
 */

let quitRequestedFromApp = false;
let blockedThisTick = false;
let recordingActive = false;
let startingUntil = 0;

let quitFromAppTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Call before quitting from Framecast's own UI (menus, tray, shortcuts). The
 * mark expires after a few seconds in case something else cancels that quit.
 */
export function markQuitFromApp() {
	quitRequestedFromApp = true;
	if (quitFromAppTimer) clearTimeout(quitFromAppTimer);
	quitFromAppTimer = setTimeout(() => {
		quitRequestedFromApp = false;
		quitFromAppTimer = null;
	}, 10_000);
	quitFromAppTimer.unref?.();
}

/** Covers the countdown and capture start-up after the user presses Start. */
export function noteRecordingStarting(windowMs = 30_000) {
	startingUntil = Date.now() + windowMs;
}

export function noteRecordingActive(active: boolean) {
	recordingActive = active;
	if (!active) {
		startingUntil = 0;
	}
}

export function shouldRefuseQuit(now = Date.now()) {
	return !quitRequestedFromApp && (recordingActive || now < startingUntil);
}

/**
 * Marks the quit currently being dispatched as refused, so other before-quit
 * listeners in this same dispatch can skip their shutdown work.
 */
export function markQuitRefused() {
	blockedThisTick = true;
	setImmediate(() => {
		blockedThisTick = false;
	});
}

export function quitWasRefused() {
	return blockedThisTick;
}

/** For tests. */
export function resetQuitGuard() {
	if (quitFromAppTimer) clearTimeout(quitFromAppTimer);
	quitFromAppTimer = null;
	quitRequestedFromApp = false;
	blockedThisTick = false;
	recordingActive = false;
	startingUntil = 0;
}
