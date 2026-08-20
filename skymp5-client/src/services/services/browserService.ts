
// TODO: send event instead of direct dependency on FormView class
import { FormView } from "../../view/formView";
import { QueryKeyCodeBindings } from "../events/queryKeyCodeBindings";

import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, DxScanCode, Menu, MenuCloseEvent, MenuOpenEvent } from "skyrimPlatform";

const unfocusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserUnfocused', {}))`;
const focusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserFocused', {}))`;

export class BrowserService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.sp.browser.setVisible(false);

    this.controller.emitter.on("queryKeyCodeBindings", (e) => this.onQueryKeyCodeBindings(e));
    this.controller.once("update", () => this.onceUpdate());
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

    if (this.badMenusOpen.size === 0 && e.isDown([DxScanCode.F6])) {
      const newState = !this.sp.browser.isFocused();
      this.sp.browser.setFocused(newState);
      if (newState) {
        this.sp.browser.executeJavaScript(focusEventString);
      } else {
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
    if (this.badMenusOpen.size === 0 && e.isDown([DxScanCode.Enter])) {
      this.sp.browser.setFocused(true);
      this.sp.browser.executeJavaScript(focusEventString);
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

  private onBrowserMessage(e: BrowserMessageEvent) {
    const onFrontLoadedEventKey = "front-loaded";

    if (e.arguments[0] === onFrontLoadedEventKey) {
      this.controller.emitter.emit("browserWindowLoaded", {});
    }
  }

  private onMenuOpen(e: MenuOpenEvent) {
    if (this.isBadMenu(e.name)) {
      this.sp.browser.setVisible(false);
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
        stillOpen = true;
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

  private readonly badMenus: Menu[] = [
    Menu.Barter,
    Menu.Book,
    Menu.Container,
    Menu.Crafting,
    Menu.Gift,
    Menu.Inventory,
    Menu.Journal,
    Menu.Lockpicking,
    Menu.Loading,
    Menu.Map,
    Menu.RaceSex,
    Menu.Stats,
    Menu.Tween,
    Menu.Console,
    Menu.Main,
  ];
}
