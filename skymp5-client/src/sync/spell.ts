import { Actor, Game, Spell, printConsole } from 'skyrimPlatform';

/**
 * What this client has added on the server's behalf.
 *
 * The sync used to remove every spell the actor had and then add back the ones
 * the server named, which is only correct if the server is the only thing that
 * ever grants a spell. It is not. getNthSpell walks abilities too, so the sweep
 * took racial powers and, worse, the abilities the game grants for wearing a
 * full armour set:
 *
 *   removeResult: true, spellName: Deathbrand Instinct
 *   removeResult: true, spellName: Shrouded Armor Full Set
 *   removeResult: true, spellName: Nightingale Armor Full Set
 *
 * Deathbrand's set bonus was reported as "not working". It worked. It was being
 * taken off a second after the game granted it, on every connect.
 *
 * Skipping the sweep for an empty list was tried first and only half helped: a
 * character with any racial spell at all has a non empty list, so the sweep ran
 * for them and took the set bonus with it exactly as before.
 *
 * Remembering what we added is the whole fix. The server stays authoritative
 * over its own list, a spell it stops granting is still taken away, and
 * anything the game granted is none of our business and is left alone.
 *
 * Per process rather than persisted, which is right: a fresh Skyrim has added
 * nothing yet, and the first sync of a session should not be removing things it
 * never granted.
 */
const addedByUs = new Set<number>();

export const removeAllSpells = (actor: Actor) => {
  let spellToRemove = new Array<Spell>();

  for (let i = 0; i < actor.getSpellCount(); i++) {
    const spell = actor.getNthSpell(i);

    if (spell) {
      spellToRemove.push(spell);
    }
  }

  for (let spell of spellToRemove) {
    const removeResult = actor.removeSpell(spell);
    printConsole(
      `removeResult: ${removeResult}, spellIdToRemove: ${spell
        .getFormID()
        .toString(16)}, spellName: ${spell.getName()}`,
    );
  }
};

/**
 * Brings the actor's spells in line with what the server says, and touches
 * nothing else.
 */
export const syncSpells = (actor: Actor, spellsIds: Array<number>) => {
  const wanted = new Set(spellsIds);

  for (const spellId of Array.from(addedByUs)) {
    if (wanted.has(spellId)) {
      continue;
    }
    const spell = Spell.from(Game.getFormEx(spellId));
    if (spell) {
      const removeResult = actor.removeSpell(spell);
      printConsole(
        `removeResult: ${removeResult}, spellIdToRemove: ${spellId.toString(
          16,
        )}, spellName: ${spell.getName()}`,
      );
    }
    addedByUs.delete(spellId);
  }

  learnSpells(actor, spellsIds);
};

export const learnSpells = (actor: Actor, spellsIds: Array<number>) => {
  for (let spellId of spellsIds) {
    const spell = Spell.from(Game.getFormEx(spellId));

    if (spell) {
      const addResult = actor.addSpell(spell, false);
      addedByUs.add(spellId);
      printConsole(
        `addResult: ${addResult}, spellIdToLearn: ${spell
          .getFormID()
          .toString(16)}, spellName: ${spell.getName()}`,
      );
    }
  }
};
