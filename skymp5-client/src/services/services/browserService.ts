
// TODO: send event instead of direct dependency on FormView class
import { FormView } from "../../view/formView";
import { QueryKeyCodeBindings } from "../events/queryKeyCodeBindings";

import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace, logError } from "../../logging";
import { BrowserMessageEvent, DxScanCode, Menu, MenuCloseEvent, MenuOpenEvent } from "skyrimPlatform";

const unfocusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserUnfocused', {}))`;
const focusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserFocused', {}))`;

export class BrowserService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.sp.browser.setVisible(false);

    this.controller.emitter.on("queryKeyCodeBindings", (e) => this.onQueryKeyCodeBindings(e));
    this.controller.once("update", () => this.onceUpdate());
    // Pruning also runs here, not only on a key press.
    //
    // A key handler is not the game thread, and Ui.isMenuOpen throws there
    // with "can't be called in this context". pruneClosedMenus believes the
    // event when it cannot ask, which is the safe answer for one call and a
    // trap over a session: a menu whose close was missed can then never be
    // pruned, typing stays blocked, and Enter stops working after a while
    // with no way back short of a relaunch.
    //
    // update is the game thread, so the question can actually be asked there.
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
  }

  // TODO: keycodes should be configurable
  private onQueryKeyCodeBindings(e: QueryKeyCodeBindings) {
    if (e.isDown([DxScanCode.F1])) {
      FormView.isDisplayingNicknames = !FormView.isDisplayingNicknames;
    }
    // Moved off F2, which Hearthheld uses for its own menu. Two handlers on
    // one key fight each other: the menu makes the browser visible to show
    // itself while this toggles it straight back off.
    if (e.isDown([DxScanCode.F3])) {
      this.sp.browser.setVisible(!this.sp.browser.isVisible());
    }
    // Ask the game which of these are really open before trusting the tally.
    //
    // badMenusOpen is built from menuOpen and menuClose events, so a single
    // missed close leaves it non-empty forever and silently kills Enter and
    // F6 until the player relogs. That is not hypothetical: opening the
    // console once was enough, and SkyrimSouls deliberately changes when menu
    // events fire, which makes a miss more likely rather than less.
    this.pruneClosedMenus();

    if (!this.typingBlocked() && e.isDown([DxScanCode.F6])) {
      const newState = !this.sp.browser.isFocused();
      this.sp.browser.setFocused(newState);
      if (newState) {
        this.sp.browser.executeJavaScript(focusEventString);
      } else {
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
    if (e.isDown([DxScanCode.Enter])) {
      if (this.typingBlocked()) {
        // Says which one, so a report is actionable rather than "chat stopped".
        const open: string[] = [];
        this.badMenusOpen.forEach((name) => open.push(name));
        logTrace(this, `Enter ignored, these are open: ${open.join(", ")}`);
      } else {
        this.sp.browser.setFocused(true);
        this.sp.browser.executeJavaScript(focusEventString);
      }
    }
    if (e.isDown([DxScanCode.Escape])) {
      if (this.sp.browser.isFocused()) {
        this.sp.browser.setFocused(false);
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
  }

  private onceUpdate() {
    this.sp.browser.setVisible(true);
  }

  /**
   * Clears menus the game says are shut, about once a second.
   *
   * Throttled because this runs every frame and the tally is almost always
   * empty; the check above makes the common case a single comparison.
   */
  private onUpdate() {
    if (this.badMenusOpen.size === 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPruneAt < 1000) {
      return;
    }
    this.lastPruneAt = now;
    this.pruneClosedMenus();
  }

  private lastPruneAt = 0;

  private onBrowserMessage(e: BrowserMessageEvent) {
    const onFrontLoadedEventKey = "front-loaded";

    if (e.arguments[0] === onFrontLoadedEventKey) {
      this.controller.emitter.emit("browserWindowLoaded", {});
    }
  }

  private onMenuOpen(e: MenuOpenEvent) {
    if (this.isBadMenu(e.name)) {
      this.sp.browser.setVisible(false);
      // Hidden is not the same as unfocused, and only the second one gives the
      // keyboard back. A browser that is invisible but still focused keeps
      // every keystroke, so the game menu that just opened receives nothing at
      // all. That is what left somebody sitting in the race menu unable to
      // type a name: the letters were going to a chat box they could not see.
      //
      // Every menu in this list is one the player is meant to be interacting
      // with instead of the browser, so taking focus back is right for all of
      // them, not only the race menu.
      if (this.sp.browser.isFocused()) {
        this.sp.browser.setFocused(false);
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
      this.badMenusOpen.add(e.name);
    } else if (e.name === Menu.HUD) {
      this.sp.browser.setVisible(true);
    }
  }

  private onMenuClose(e: MenuCloseEvent) {
    if (this.badMenusOpen.delete(e.name)) {
      if (this.badMenusOpen.size === 0) {
        this.sp.browser.setVisible(true);
      }
    }

    if (e.name === Menu.HUD) {
      this.sp.browser.setVisible(false);
    }
  }

  /**
   * Drops any menu the game says is no longer open.
   *
   * Cheap: the set is empty almost always, and holds one or two entries
   * otherwise, so this costs nothing on the overwhelming majority of calls.
   */
  private pruneClosedMenus() {
    if (this.badMenusOpen.size === 0) {
      return;
    }
    const names: string[] = [];
    this.badMenusOpen.forEach((name) => names.push(name));
    for (const name of names) {
      let stillOpen = false;
      try {
        stillOpen = this.sp.Ui.isMenuOpen(name);
      } catch (e) {
        // If the game will not answer, believe the event rather than guess.
        // Reported once, because this being silent is what let the condition
        // above go unnoticed: every prune failing looks exactly like every
        // menu genuinely still being open.
        stillOpen = true;
        if (!this.warnedAboutMenuQuery) {
          this.warnedAboutMenuQuery = true;
          logError(this, `could not ask the game which menus are open:`, e);
        }
      }
      if (!stillOpen) {
        this.badMenusOpen.delete(name);
      }
    }
    if (this.badMenusOpen.size === 0) {
      // Whatever hid the overlay is gone, so put it back.
      this.sp.browser.setVisible(true);
    }
  }

  private isBadMenu(menu: string) {
    return this.badMenus.includes(menu as Menu);
  }

  private badMenusOpen = new Set<string>();
  private warnedAboutMenuQuery = false;

  /**
   * Menus that genuinely conflict with typing, as opposed to merely being open.
   *
   * SkyrimSouls is installed here and makes most menus non blocking, so a
   * player can open a container or a crafting bench and walk away with it still
   * technically open. Ui.isMenuOpen then answers true quite correctly, pruning
   * keeps the entry, and Enter stays dead until they find and close a menu they
   * have no reason to think is open. Activating a Settlement Builder door does
   * exactly this: it opens a crafting menu.
   *
   * These four are different. The console owns the keyboard, race menu and
   * loading are modal, and Main means not being in the world at all. Nothing
   * else is a reason to refuse someone their chat window.
   */
  private readonly typingBlockers: Menu[] = [
    Menu.Console,
    Menu.RaceSex,
    Menu.Loading,
    Menu.Main,
  ];

  /** Whether anything open right now actually stops the player typing. */
  private typingBlocked(): boolean {
    let blocked = false;
    this.badMenusOpen.forEach((name) => {
      if (this.typingBlockers.includes(name as Menu)) {
        blocked = true;
      }
    });
    return blocked;
  }

  private readonly badMenus: Menu[] = [
    Menu.Barter,
    Menu.Book,
    Menu.Container,
    Menu.Crafting,
    Menu.Gift,
    Menu.Journal,
    Menu.Lockpicking,
    Menu.Loading,
    Menu.Map,
    Menu.RaceSex,
    Menu.Stats,
    Menu.Tween,
    Menu.Console,
    // Inventory is deliberately absent too, and for a different reason.
    //
    // Hiding the overlay hides all of it, because it is one browser layer and
    // not a set of windows the game can pick between. So the cost of hiding it
    // for the inventory is the hunger dial and the skill bar going with it,
    // and those are exactly the two things somebody has the inventory open to
    // check against: how hungry they are while looking at what there is to
    // eat, and how far off the next level is while looking at what they are
    // carrying. Leaving it up is what makes the corner of the screen worth
    // reading at the moment it is being read.
    //
    // Visible is not focused. The keyboard only goes to the browser when it is
    // focused, which happens when somebody opens chat, so the inventory still
    // receives everything typed at it.
    //
    // The other menus in this list stay. Each one is a screen a player is
    // looking at instead of the world rather than alongside it, and a chat
    // window over the map is in the way rather than useful.
    //
    // Main is deliberately absent, unlike in typingBlockers above.
    //
    // The character screen is shown at the main menu, before anyone has
    // spawned, so that is the one moment the overlay must be on screen rather
    // than hidden. It worked by accident: the main menu opens once at startup,
    // before the client has connected, so nothing was listening yet and the
    // setVisible(true) that draws the screen came afterwards and won.
    //
    // A main menu replacer breaks that accident by opening the menu again once
    // we are listening. The screen is drawn, the event arrives, the overlay is
    // hidden, and the player is left looking at a main menu with no way in and
    // nothing in any log: the server sent the screen and the client says it
    // showed it.
  ];
}
