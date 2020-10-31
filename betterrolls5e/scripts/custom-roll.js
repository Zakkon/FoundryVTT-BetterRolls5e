import { i18n, isAttack, isSave, getSave, isCheck } from "./betterrolls5e.js";
import { DiceCollection, ActorUtils, ItemUtils, Utils } from "./utils.js";
import { Renderer } from "./renderer.js";

/**
 * Roll type for advantage/disadvantage/etc
 * @typedef {"highest" | "lowest" | null} RollState
 */

/**
 * Parameters used when full rolling an actor
 * @typedef FullRollActorParams
 * @type {object}
 * @property {number?} adv 
 * @property {number?} disadv 
 * @property {number?} critThreshold
 */

import { DND5E } from "../../../systems/dnd5e/module/config.js";

let dnd5e = DND5E;
let DEBUG = false;

const blankRoll = new Roll("0").roll(); // Used for CHAT_MESSAGE_TYPES.ROLL, which requires a roll that Better Rolls otherwise does not need

function debug() {
	if (DEBUG) {
		console.log.apply(console, arguments);
	}
}

function createChatData(actor, content, { hasMaestroSound = false }={}) {
	return {
		user: game.user._id,
		content: content,
		speaker: {
			actor: actor._id,
			token: actor.token,
			alias: actor.token?.name || actor.name
		},
		type: CONST.CHAT_MESSAGE_TYPES.ROLL,
		roll: blankRoll,
		...Utils.getWhisperData(),
		sound: Utils.getDiceSound(hasMaestroSound)
	};
}

/**
 * Populates a dice pool using a render model or a list of render models
 * @param {import("./renderer.js").RenderModel | Array<import("./renderer.js").RenderModel>} models 
 * @param {DiceCollection} dicePool 
 */
function populateDicePool(models, dicePool) {
	// If this is an array, recursively run on sub entries
	if (models instanceof Array) {
		models.forEach(e => populateDicePool(e, dicePool));
		return;
	}

	if (models.type === "multiroll") {
		dicePool?.push(...models.entries.map(e => e.roll));
	} else if (models.type === "damage") {
		dicePool.push(models.baseRoll, models.critRoll);
	}
}

/**
 * Returns an item and its actor if given an item, or just the actor otherwise.
 * @param {Item | Actor} actorOrItem
 */
function resolveActorOrItem(actorOrItem) {
	if (!actorOrItem) {
		return {};
	}

	if (actorOrItem instanceof Item) {
		return { item: actorOrItem, actor: actorOrItem?.actor };
	} else {
		return { actor: actorOrItem };
	}
}

/**
 * General class for macro support, actor rolls, and most static rolls.
 */
export class CustomRoll {
	/**
	 * Returns header data to be used for rendering
	 */
	static constructHeaderData(actorOrItem, label, { slotLevel=null }={}) {
		const { item, actor } = resolveActorOrItem(actorOrItem);
		const img = item ? item.img : ActorUtils.getImage(actor);

		/** @type {import("./renderer.js").HeaderDataProps}  */ 
		const results = {
			type: "header",
			img,
			label,
			slotLevel
		}

		return results;
	}
	
	/**
	 * Constructs multiroll data to be used for rendering
	 * @param {string} formula 
	 * @param {Object} options Roll options used to construct the multiroll.
	 * @param {number?} options.critThreshold minimum roll on the dice to cause a critical roll.
	 * @param {number?} options.numRolls number of rolls to perform
	 * @param {string?} options.title title to display above the roll
	 * @param {RollState?} options.rollState highest or lowest
	 * @param {string?} options.rollType metadata param for attack vs damage.
	 * @param {boolean?} options.elvenAccuracy whether the actor should apply elven accuracy 
	 */
	static constructMultiRoll(formula, options={}) {
		const { critThreshold, title, rollState, rollType, elvenAccuracy } = options;

		let numRolls = options.numRolls || game.settings.get("betterrolls5e", "d20Mode");
		if (rollState && numRolls == 1) {
			numRolls = 2;
		}

		// Apply elven accuracy
		if (numRolls == 2 && elvenAccuracy && rollState !== "lowest") {
			numRolls = 3;
		}

		const entries = [];
		for (let i = 0; i < numRolls; i++) {
			const roll = new Roll(formula).roll();
			entries.push(Utils.processRoll(roll, critThreshold, [20]));
		}

		// Mark ignored rolls due to advantage/disadvantage
		if (rollState) {
			let rollTotals = entries.map(r => r.roll.total);
			let chosenResult = rollTotals[0];
			if (rollState == "highest") {
				chosenResult = rollTotals.sort(function(a, b){return a-b})[rollTotals.length-1];
			} else if (rollState == "lowest") {
				chosenResult = rollTotals.sort(function(a, b){return a-b})[0];
			}

			// Mark the non-results as ignored
			entries.filter(r => r.roll.total != chosenResult).forEach(r => r.ignored = true);
		}

		/** @type {import("./renderer.js").MultiRollDataProps} */
		const results = {
			type: "multiroll",
			title,
			rollState,
			rollType,
			formula,
			entries,
			isCrit: entries.some(e => !e.ignored && e.isCrit)
		};

		return results;
	}

	/**
	 * Constructs and rolls damage data to be used in rendering
	 * @param {string | roll} formulaOrRoll A formula or roll object to be used
	 * @param {object} options
	 * @param {} options.critBehavior
	 * @param {Item?} options.item Optional item property. Used to calculate savage if savage isn't given
	 * @param {boolean?} options.isCrit Whether to roll crit damage. Ignored if critBehavior is set to "0"
	 * @param {boolean?} options.savage If true/false, sets the savage property. Fallsback to using the item if not given, or false otherwise.
	 * @param {boolean?} options.isVersatile Whether the roll is for versatile. Affects printout
	 * @param {string?} options.context Context string to display
	 * @param {string?} options.damageType
	 * @param {string?} options.title title to display. If not given defaults to damage type
	 */
	static constructDamageRoll(formulaOrRoll, options={}) {
		const { item, isCrit, isVersatile, context, damageType, title } = options;
		const savage = options.savage ?? ItemUtils.appliesSavageAttacks(item);
		const critBehavior = options.critBehavior || game.settings.get("betterrolls5e", "critBehavior");
		
		const roll = formulaOrRoll instanceof Roll ? formulaOrRoll : new Roll(formulaOrRoll);
		const total = roll.total ?? roll.roll();

		let critRoll = null;
		if (isCrit && critBehavior !== "0") {
			critRoll = ItemUtils.getCritRoll(roll.formula, total, { critBehavior, savage });
		}

		/** @type {import("./renderer.js").DamageDataProps} */
		const results = {
			type: "damage",
			title,
			damageType,
			context,
			baseRoll: roll,
			critRoll,
			isVersatile: isVersatile ?? false
		};

		return results;
	}

	/**
	 * Constructs and rolls damage data for a damage entry in an item.
	 * Can roll for an index, versatile (replaces first), or other.
	 * @param {Item} item 
	 * @param {number | "versatile" | "other" } index 
	 * @param {object} options
	 * @param {} options.critBehavior
	 * @param {number?} options.slotLevel
	 * @param {string?} options.context Optional damage context. Defaults to the configured damage context
	 * @param {boolean?} options.isCrit Whether to roll crit damage
	 */
	static constructItemDamageRoll(item, index, options={}) {
		const { slotLevel, isCrit, critBehavior } = options;
		const itemData = item.data.data;
		const flags = item.data.flags.betterRolls5e;
		const rollData = ItemUtils.getRollData(item, { slotLevel });
		const isVersatile = index === "versatile";
		const isFirst = index === 0 || index === "versatile";

		// Bonus parts to add to the formula
		const parts = [];

		// Determine certain fields based on index
		let title = null;
		let context = "";
		let damageFormula = null;
		let damageType = null;
		
		if (index === "other") {
			damageFormula = itemData.formula;
			title = i18n("br5e.chat.other");
			context = flags.quickOther.context;
		} else {
			// If versatile, use properties from the first entry
			const trueIndex = isFirst ? 0 : index;

			damageFormula = isVersatile ? itemData.damage.versatile : itemData.damage.parts[trueIndex][0]; 
			damageType = itemData.damage.parts[trueIndex][1];
			context = options.context || (flags.quickDamage.context?.[trueIndex]);

			// Scale damage if its the first entry
			if (damageFormula && isFirst) {
				damageFormula = ItemUtils.scaleDamage(item, slotLevel, index, isVersatile, rollData) || damageFormula;
			}

			// Add any roll bonuses but only to the first entry
			if (isFirst && rollData.bonuses && isAttack(item)) {
				let actionType = `${itemData.actionType}`;
				if (rollData.bonuses[actionType].damage) {
					parts.unshift(rollData.bonuses[actionType].damage);
				}
			}
		}

		// Require a formula to continue
		if (!damageFormula) { 
			return null;
		}

		// Assemble roll data and defer to the general damage construction
		const rollFormula = [damageFormula, ...parts].join("+");
		const baseRoll = new Roll(rollFormula, rollData);
		return CustomRoll.constructDamageRoll(baseRoll, {
			critBehavior, item, title, context, damageType, isVersatile, isCrit
		});
	}

	/**
	 * Creates multiple item damage rolls. This returns an array,
	 * so when adding to a model list, add them separately or use the splat operator.
	 * @param {*} item 
	 * @param {number[] | "all"} damageIndices 
	 * @param {*} options 
	 */
	static constructItemDamageRollRange(item, damageIndices, options={}) {
		// If all, damage indices between a sequential list from 0 to length - 1
		if (damageIndices === "all") {
			const numEntries = item.data.data.damage.parts.length;
			damageIndices = [...Array(numEntries).keys()];
		}

		// If versatile, replace any "first" entry (only those)
		if (options.versatile) {
			damageIndices = damageIndices.map(i => i === 0 ? "versatile" : i);
		}

		return damageIndices.map(i => CustomRoll.constructItemDamageRoll(item, i, options));
	}

	/**
	 * Sends a chat message using the given models, that can be created using
	 * the CustomRoll.constructX() methods.
	 * @param {*} actor 
	 * @param {*} models 
	 * @param {object} param3
	 * @param {Item?} param3.item Optional Item to put in the card props and to use for certain defaults.
	 * @param {string[]?} param3.properties List of properties to show at the bottom. Uses item properties if null.
	 * @param {boolean} param3.isCrit If the card should be labeled as a crit in the properties 
	 */
	static async sendChatMessage(actor, models, { item=null, properties=null, isCrit=null }={}) {
		const hasMaestroSound = item && ItemUtils.hasMaestroSound(item);

		// Render the models
		const templates = await Promise.all(models.map(Renderer.renderModel));
		const content = await Renderer.renderCard(templates, { actor, item, properties, isCrit });
		
		// Output the rolls to chat
		const dicePool = new DiceCollection();
		populateDicePool(models.filter(e => !e?.hidden), dicePool);
		await dicePool.flush();

		// Send the chat message
		return ChatMessage.create(createChatData(actor, content, { hasMaestroSound }));
	}
	
	/**
	 * Converts {args, disadv} params into a roll state object
	 * @param {*} args
	 * @returns {RollState} 
	 */
	static getRollState(args) {
		if (!args) {
			return null;
		}

		let adv = args.adv || 0;
		let disadv = args.disadv || 0;
		if (adv > 0 || disadv > 0) {
			if (adv > disadv) { return "highest"; }
			else if (adv < disadv) { return "lowest"; }
		} else { return null; }
	}
	
	// Returns an {adv, disadv} object when given an event
	static async eventToAdvantage(ev, itemType) {
		if (ev.shiftKey) {
			return {adv:1, disadv:0};
		} else if ((keyboard.isCtrl(ev))) {
			return {adv:0, disadv:1};
		} else if (game.settings.get("betterrolls5e", "queryAdvantageEnabled")) {
			// Don't show dialog for items that aren't tool or weapon.
			if (itemType != null && !itemType.match(/^(tool|weapon)$/)) {
				return {adv:0, disadv:0};
			}
			return new Promise(resolve => {
				new Dialog({
					title: i18n("br5e.querying.title"),
					buttons: {
						disadvantage: {
							label: i18n("br5e.querying.disadvantage"),
							callback: () => resolve({adv:0, disadv:1})
						},
						normal: {
							label: i18n("br5e.querying.normal"),
							callback: () => resolve({adv:0, disadv:0})
						},
						advantage: {
							label: i18n("br5e.querying.advantage"),
							callback: () => resolve({adv:1, disadv:0})
						}
					}
				}).render(true);
			});
		} else {
			return {adv:0, disadv:0};
		}
	}

	/**
	 * Internal method to perform a basic actor full roll of "something".
	 * It creates and display a chat message on completion.
	 * @param {*} actor 
	 * @param {string} label 
	 * @param {string} formula 
	 * @param {string} rollType 
	 * @param {FullRollActorParams} params 
	 */
	static async fullRollActor(actor, label, formula, rollType, params) {		
		// Entries to show for the render
		return CustomRoll.sendChatMessage(actor, [
			CustomRoll.constructHeaderData(actor, label),
			CustomRoll.constructMultiRoll(formula, { 
				rollState: CustomRoll.getRollState(params), 
				critThreshold: params?.critThreshold,
				rollType
			})
		]);
	}
	
	/**
	 * Creates and displays a chat message to show a full skill roll
	 * @param {*} actor 
	 * @param {string} skill shorthand referring to the skill name
	 * @param {FullRollActorParams} params parameters
	 */
	static async fullRollSkill(actor, skill, params={}) {
		const label = i18n(dnd5e.skills[skill]);
		const formula = ActorUtils.getSkillCheckRoll(actor, skill).formula;
		return CustomRoll.fullRollActor(actor, label, formula, "skill", params);
	}

	/**
	 * Rolls a skill check for an actor
	 * @param {*} actor 
	 * @param {string} ability Ability shorthand 
	 * @param {FullRollActorParams} params 
	 */
	static async rollCheck(actor, ability, params) {
		return await CustomRoll.fullRollAttribute(actor, ability, "check", params);
	}
	
	/**
	 * Rolls a saving throw for an actor
	 * @param {*} actor 
	 * @param {string} ability Ability shorthand 
	 * @param {FullRollActorParams} params 
	 */
	static async rollSave(actor, ability, params) {
		return await CustomRoll.fullRollAttribute(actor, ability, "save", params);
	}
	
	/**
	 * Creates and displays a chat message with the requested ability check or saving throw.
	 * @param {Actor5e} actor		The actor object to reference for the roll.
	 * @param {String} ability		The ability score to roll.
	 * @param {String} rollType		String of either "check" or "save"
	 * @param {FullRollActorParams} params
	 */
	static async fullRollAttribute(actor, ability, rollType, params={}) {
		const label = dnd5e.abilities[ability];

		let titleString;
		let formula = "";
		if (rollType === "check") {
			formula = ActorUtils.getAbilityCheckRoll(actor, ability).formula;
			titleString = `${i18n(label)} ${i18n("br5e.chat.check")}`;
		} else if (rollType === "save") {
			formula = ActorUtils.getAbilitySaveRoll(actor, ability).formula;
			titleString = `${i18n(label)} ${i18n("br5e.chat.save")}`;
		}

		return CustomRoll.fullRollActor(actor, titleString, formula, rollType, params);
	}
	
	static newItemRoll(item, params, fields) {
		return new CustomItemRoll(item, params, fields);
	}
}

let defaultParams = {
	title: "",
	forceCrit: false,
	preset: false,
	properties: true,
	slotLevel: null,
	useCharge: {},
	useTemplate: false,
	event: null,
	adv: 0,
	disadv: 0,
};

/*
	CustomItemRoll(item,
	{
		forceCrit: false,
		quickRoll: false,
		properties: true,
		slotLevel: null,
		useCharge: {},
		useTemplate: false,
		adv: 0,
		disadv: 0,
	},
	[
		["attack", {triggersCrit: true}],
		["damage", {index:0, versatile:true}],
		["damage", {index:[1,2,4]}],
	]
	).toMessage();
*/

// A custom roll with data corresponding to an item on a character's sheet.
export class CustomItemRoll {
	constructor(item, params, fields) {
		this.item = item;
		this.actor = item.actor;
		this.itemFlags = item.data.flags;
		this.params = mergeObject(duplicate(defaultParams), params || {});	// General parameters for the roll as a whole.
		this.fields = fields;	// Where requested roll fields are stored, in the order they should be rendered.

		/** @type {Array<import("./renderer.js").RenderModel>} */
		this.models = [];		// Data results from fields, which get turned into templates
		
		this.rolled = false;
		this.isCrit = this.params.forceCrit || false;			// Defaults to false, becomes "true" when a valid attack or check first crits.
		this.rollState = null;
		this.params.event = this.params.event || event;

		this._updateConfig();
		this._setupRollState();
	}
	
	/**
	 * Update config settings in the roll.
	 * TODO: This needs to be moved to an actual settings ES module.
	 * @private
	 */
	_updateConfig() {
		const getBRSetting = (setting) => game.settings.get("betterrolls5e", setting);

		this.config = {
			playRollSounds: getBRSetting("playRollSounds"),
			hasMaestroSound: ItemUtils.hasMaestroSound(this.item),
			damageRollPlacement: getBRSetting("damageRollPlacement"),
			rollTitlePlacement: getBRSetting("rollTitlePlacement"),
			damageTitlePlacement: getBRSetting("damageTitlePlacement"),
			damageContextPlacement: getBRSetting("damageContextPlacement"),
			contextReplacesTitle: getBRSetting("contextReplacesTitle"),
			contextReplacesDamage: getBRSetting("contextReplacesDamage"),
			critString: getBRSetting("critString"),
			critBehavior: getBRSetting("critBehavior"),
			quickDefaultDescriptionEnabled: getBRSetting("quickDefaultDescriptionEnabled"),
			altSecondaryEnabled: getBRSetting("altSecondaryEnabled"),
			d20Mode: getBRSetting("d20Mode"),
			hideDC: getBRSetting("hideDC")
		};
	}
	
	/**
	 * Initialization function to detect advantage/disadvantage from events and setup the roll state.
	 * @private
	 */
	_setupRollState() {
		const modifiers = Utils.getEventRollModifiers(this.params.event);
		this.params = mergeObject(this.params, modifiers);
		
		this.rollState = null;
		const { adv, disadv } = this.params;
		if (adv > 0 || disadv > 0) {
			if (adv > disadv) { this.rollState = "highest"; }
			else if (adv < disadv) { this.rollState = "lowest"; }
		}
	}
	
	/**
	 * Internal function to process fields and populate the internal data.
	 * Call toMessage() to create the final chat message and show the result
	 */
	async roll() {
		if (this.rolled) {
			console.log("Already rolled!", this);
			return;
		}

		const { params, item } = this;

		await ItemUtils.ensureFlags(item);
		const actor = item.actor;
		const itemData = item.data.data;
		
		Hooks.call("preRollItemBetterRolls", this);
		
		if (Number.isInteger(params.preset)) {
			this.updateForPreset();
		}

		if (this.params.useCharge.resource) {
			const consume = itemData.consume;
			if ( consume?.type === "ammo" ) {
				this.ammo = this.actor.items.get(consume.target);
			}
		}
		
		if (!params.slotLevel) {
			if (item.data.type === "spell") {
				params.slotLevel = await this.configureSpell();
				if (params.slotLevel === "error") { 
					return "error"; 
				}
			}
		}

		// Convert all requested fields into templates to be entered into the chat message.
		this.models = await this._processFields();
		
		// Load Item Footer Properties if params.properties is true
		this.properties = (params.properties) ? ItemUtils.getPropertyList(item) : [];
		
		// Check to consume charges. Prevents the roll if charges are required and none are left.
		let chargeCheck = await this.consumeCharge();
		if (chargeCheck === "error") {
			return "error";
		}

		if (params.useTemplate && (item.data.type == "feat" || item.data.data.level == 0)) {
			this.placeTemplate();
		}
		
		this.rolled = true;
		
		await Hooks.callAll("rollItemBetterRolls", this);
		await new Promise(r => setTimeout(r, 25));
		
		if (chargeCheck === "destroy") {
			await actor.deleteOwnedItem(item.id);
		}
	}

	/**
	 * Function that immediately processes and renders a given field
	 * @param {*} field 
	 */
	async fieldToTemplate(field) {
		let item = this.item;
		let fieldType = field[0].toLowerCase();
		let fieldArgs = field.slice();
		fieldArgs.splice(0,1);
		switch (fieldType) {
			case 'attack':
				// {adv, disadv, bonus, triggersCrit, critThreshold}
				this.models.push(this._rollAttack(fieldArgs[0]));
				break;
			case 'toolcheck':
			case 'tool':
			case 'check':
				this.models.push(this._rollTool(fieldArgs[0]));
				break;
			case 'damage':
				// {damageIndex: 0, forceVersatile: false, forceCrit: false}
				this.models.push(...this._rollDamageBlock(fieldArgs[0]));
				if (this.ammo) {
					this.item = this.ammo;
					delete this.ammo;
					await this.fieldToTemplate(['damage', {index: 'all', versatile: false, crit: this.isCrit, context: `[${this.item.name}]`}]);
					this.item = item;
				}
				break;
			case 'savedc':
				// {customAbl: null, customDC: null}
				let abl, dc;
				if (fieldArgs[0]) {
					abl = fieldArgs[0].abl;
					dc = fieldArgs[0].dc;
				}
				this.models.push({ type: "raw", content: await this.saveRollButton({customAbl:abl, customDC:dc})});
				break;
			case 'other':
				if (item.data.data.formula) { 
					this.models.push(this._rollOther());
				}
				break;
			case 'custom':
				this.models.push(this._rollCustom(fieldArgs[0]));
				break;
			case 'description':
			case 'desc':
				// Display info from Components module
				let componentField = "";
				if (game.modules.get("components5e") && game.modules.get("components5e").active) {
					componentField = window.ComponentsModule.getComponentHtml(item, 20);
				}
				fieldArgs[0] = {text: componentField + item.data.data.description.value};
			case 'text':
				if (fieldArgs[0].text) {
					this.models.push({
						type: "description",
						content: fieldArgs[0].text
					});
				}
				break;
			case 'flavor':
				this.models.push({
					type: "description",
					isFlavor: true,
					content: fieldArgs[0]?.text ?? this.item.data.data.chatFlavor
				});
				break;
			case 'crit':
				const extra = this._rollCritExtra();
				if (extra) {
					this.models.push(extra);
				}
				break;
		}
		return true;
	}

	/**
	 * Processes all fields, building a collection of models and returning them
	 */
	async _processFields() {
		this.models.push(this._rollHeader());
		for (let i=0;i<this.fields.length;i++) {
			await this.fieldToTemplate(this.fields[i]);
		}

		if (this.isCrit && this.hasDamage && this.item.data.flags.betterRolls5e?.critDamage?.value) {
			await this.fieldToTemplate(["crit"]);
		}

		return this.models;
	}
	
	/**
	 * Creates and sends a chat message to all players (based on whisper settings).
	 * If not already rolled and rendered, roll() is called first.
	 */
	async toMessage() {
		if (!this.rolled) {
			await this.roll();
		}

		if (this.content === "error") return;

		const hasMaestroSound = this.config.hasMaestroSound;
		this.chatData = createChatData(this.actor, this.content, { hasMaestroSound });
		await Hooks.callAll("messageBetterRolls", this, this.chatData);

		// Render and send the chat message
		const { item, isCrit, properties } = this;
		return await CustomRoll.sendChatMessage(item.actor, this.models, { item, isCrit, properties });
	}
	
	/**
	 * Updates the rollRequests based on the br5e flags.
	 */
	updateForPreset() {
		let item = this.item,
			itemData = item.data.data,
			flags = item.data.flags,
			brFlags = flags.betterRolls5e,
			preset = this.params.preset,
			properties = false,
			useCharge = {},
			useTemplate = false,
			fields = [],
			val = (preset === 1) ? "altValue" : "value";
			
		
		if (brFlags) {
			// Assume new action of the button based on which fields are enabled for Quick Rolls
			function flagIsTrue(flag) {
				return (brFlags[flag] && (brFlags[flag][val] == true));
			}

			function getFlag(flag) {
				return (brFlags[flag] ? (brFlags[flag][val]) : null);
			}
			
			if (flagIsTrue("quickFlavor") && itemData.chatFlavor) { fields.push(["flavor"]); }
			if (flagIsTrue("quickDesc")) { fields.push(["desc"]); }
			if (flagIsTrue("quickAttack") && isAttack(item)) { fields.push(["attack"]); }
			if (flagIsTrue("quickCheck") && isCheck(item)) { fields.push(["check"]); }
			if (flagIsTrue("quickSave") && isSave(item)) { fields.push(["savedc"]); }
			
			if (brFlags.quickDamage && (brFlags.quickDamage[val].length > 0)) {
				for (let i = 0; i < brFlags.quickDamage[val].length; i++) {
					let isVersatile = (i == 0) && flagIsTrue("quickVersatile");
					if (brFlags.quickDamage[val][i]) { fields.push(["damage", {index:i, versatile:isVersatile}]); }
				}
			}


			if (flagIsTrue("quickOther")) { fields.push(["other"]); }
			if (flagIsTrue("quickProperties")) { properties = true; }

			if (brFlags.quickCharges) {
				useCharge = duplicate(getFlag("quickCharges"));
			}
			if (flagIsTrue("quickTemplate")) { useTemplate = true; }
		} else { 
			//console.log("Request made to Quick Roll item without flags!");
			fields.push(["desc"]);
			properties = true;
		}
		
		this.params = mergeObject(this.params, {
			properties,
			useCharge,
			useTemplate,
		});

		console.log(this.params);
		
		this.fields = fields.concat((this.fields || []).slice());
	}

	_rollHeader() {
		const slotLevel = this.params.slotLevel;
		let printedSlotLevel = null;
		if (this.item && this.item.data.type === "spell" && slotLevel != this.item.data.data.level) {
			printedSlotLevel = dnd5e.spellLevels[slotLevel];
		}

		return CustomRoll.constructHeaderData(this.item, this.item.name, { 
			slotLevel: printedSlotLevel
		});
	}

	/**
	 * Rolls an attack roll for the item.
	 * @param {Object} props				Object containing all named parameters
	 * @param {Number} props.adv			1 for advantage
	 * @param {Number} props.disadv			1 for disadvantage
	 * @param {String} props.bonus			Additional situational bonus
	 * @param {Boolean} props.triggersCrit	Whether a crit for this triggers future damage rolls to be critical
	 * @param {Number} props.critThreshold	Minimum roll for a d20 is considered a crit
	 * @private
	 */
	_rollAttack(props) {
		let args = mergeObject({
			adv: this.params.adv,
			disadv: this.params.disadv,
			bonus: null,
			triggersCrit: true,
			critThreshold: null
		}, props || {});

		let itm = this.item;
		const itemData = itm.data.data;
		let title = (this.config.rollTitlePlacement !== "0") ? i18n("br5e.chat.attack") : null;
		
		this.hasAttack = true;
		
		// Add critical threshold
		let critThreshold = 20;
		let characterCrit = 20;
		try { 
			characterCrit = Number(getProperty(itm, "actor.data.flags.dnd5e.weaponCriticalThreshold")) || 20;
		} catch(error) { 
			characterCrit = itm.actor.data.flags.dnd5e.weaponCriticalThreshold || 20;
		}
		
		let itemCrit = Number(getProperty(itm, "data.flags.betterRolls5e.critRange.value")) || 20;
		//	console.log(critThreshold, characterCrit, itemCrit);
		
		if (args.critThreshold) {
			// If a specific critThreshold is set, use that
			critThreshold = args.critThreshold;
		} else {
			// Otherwise, determine it from character & item data
			if (['mwak', 'rwak'].includes(itemData.actionType)) {
				critThreshold = Math.min(critThreshold, characterCrit, itemCrit);
			} else {
				critThreshold = Math.min(critThreshold, itemCrit);
			}
		}

		// Get ammo bonus and add to title if relevant
		const ammoBonus = this.ammo?.data.data.attackBonus;
		if (ammoBonus) {
			title += ` [${this.ammo.name}]`;
		}
		
		// Perform the final construction and begin rolling
		const abilityMod = ItemUtils.getAbilityMod(itm);
		const rollState = CustomRoll.getRollState(args);
		const formula = ItemUtils.getAttackRoll(itm, {
			abilityMod,
			ammoBonus,
			bonus: args.bonus
		}).formula;
		const multiRollData = CustomRoll.constructMultiRoll(formula, {
			rollState,
			title,
			critThreshold,
			elvenAccuracy: ActorUtils.testElvenAccuracy(itm.actor, abilityMod)
		});
		
		// If this can trigger a crit and it also crit, flag it as a crit.
		// Currently, crits cannot be un-set.
		if (args.triggersCrit && multiRollData.isCrit) {
			this.isCrit = true;
		}

		return multiRollData;
	}

	/**
	 * 
	 * @param {*} preArgs 
	 * @private
	 */
	async _rollTool(preArgs) {
		let args = mergeObject({adv: 0, disadv: 0, bonus: null, triggersCrit: true, critThreshold: null, rollState: this.rollState}, preArgs || {});
		let itm = this.item;
		const title = args.title || ((this.config.rollTitlePlacement != "0") ? i18n("br5e.chat.check") : null);
			
		// Begin rolling the multiroll, and return the result
		const rollState = CustomRoll.getRollState(args);
		const formula = ItemUtils.getToolRoll(itm, args.bonus).formula;
		const multiRollData = CustomRoll.constructMultiRoll(formula, {
			rollState,
			title,
			critThreshold: args.critThreshold,
			elvenAccuracy: ActorUtils.testElvenAccuracy(itm.actor, abl)
		});
		
		this.isCrit = args.triggersCrit || multiRollData.isCrit;

		return multiRollData;
	}

	/**
	 * 
	 * @param {*} args
	 * @private 
	 */
	_rollCustom(args) {
		/* args:
				title			title of the roll
				formula			the roll formula
				rolls			number of rolls
				rollState		"adv" or "disadv" converts to "highest" or "lowest"
		*/
		let rollStates = {
			null: null,
			"adv": "highest",
			"disadv": "lowest"
		};
		
		const { rolls, formula, rollState } = args;
		let rollData = ItemUtils.getRollData(this.item);
		const resolvedFormula = new Roll(formula, rollData).formula;
		this.models.push(CustomRoll.constructMultiRoll(resolvedFormula || "1d20", {
			numRolls: rolls || 1,
			rollState: rollStates[rollState],
			rollType: "custom",
		}));
	}

	_rollDamageBlock({index, versatile, crit, context} = {}) {
		const wasAll = index === "all";

		// If all, damage indices between a sequential list from 0 to length - 1
		if (index === "all") {
			const numEntries = this.item.data.data.damage.parts.length;
			index = [...Array(numEntries).keys()]
		}

		if (Number.isInteger(index)) {
			index = [index];
		}

		const results = [];
		for (const idx of index) {
			results.push(this._rollDamage({
				damageIndex: idx,
				// versatile damage will only replace the first damage formula in an "all" damage request
				forceVersatile: (idx == 0 || !wasAll) ? versatile : false,
				forceCrit: crit,
				customContext: context
			}))
		}

		return results;
	}
	
	_rollDamage({damageIndex = 0, forceVersatile = false, forceCrit = false, bonus = 0, customContext = null}) {
		const item = this.item;
		const itemData = item.data.data;

		// Makes the custom roll flagged as having a damage roll.
		this.hasDamage = true;

		// Change first damage formula if versatile
		const hasVersatile = itemData.damage.versatile.length;
		if (((this.params.versatile && damageIndex === 0) || forceVersatile) && hasVersatile > 0) {
			damageIndex = "versatile";
		}

		const isCrit = (forceCrit == true || (this.isCrit && forceCrit !== "never"));
		return CustomRoll.constructItemDamageRoll(item, damageIndex, {
			slotLevel: this.params.slotLevel,
			context: customContext,
			isCrit
		});
	}

	_rollCritExtra(index) {
		let damageIndex = (index ? toString(index) : null) || 
			this.item.data.flags.betterRolls5e?.critDamage?.value || 
			"";
		if (damageIndex) {
			return this._rollDamage({damageIndex:Number(damageIndex), forceCrit:"never"});
		}
	}
	
	/**
	 * Rolls the Other Formula field. Is subject to crits.
	 */
	_rollOther() {
		const isCrit = this.isCrit;
		const critBehavior = this.params.critBehavior ? this.params.critBehavior : this.config.critBehavior;
		return CustomRoll.constructItemDamageRoll(this.item, "other", {
			critBehavior,
			isCrit,
			slotLevel: this.params.slotLevel,
		});
	}
	
	/* 	Generates the html for a save button to be inserted into a chat message. Players can click this button to perform a roll through their controlled token.
	*/
	async saveRollButton({customAbl = null, customDC = null}) {
		let item = this.item;
		let actor = item.actor;
		let saveData = getSave(item);
		if (customAbl) { saveData.ability = saveArgs.customAbl; }
		if (customDC) { saveData.dc = saveArgs.customDC; }
		
		let hideDC = (this.config.hideDC == "2" || (this.config.hideDC == "1" && actor.data.type == "npc")); // Determine whether the DC should be hidden

		let divHTML = `<span ${hideDC ? 'class="hideSave"' : null} style="display:inline;line-height:inherit;">${saveData.dc}</span>`;
		
		let saveLabel = `${i18n("br5e.buttons.saveDC")} ` + divHTML + ` ${dnd5e.abilities[saveData.ability]}`;
		let button = {
			type: "saveDC",
			html: await renderTemplate("modules/betterrolls5e/templates/red-save-button.html", {data: saveData, saveLabel: saveLabel})
		}
		
		return button;
	}
	
	async configureSpell() {
		let item = this.item;
		let actor = item.actor;
		let lvl = null;
		let consume = false;
		let placeTemplate = false;
		let isPact = false;
		
		// Only run the dialog if the spell is not a cantrip
		if (item.data.data.level > 0) {
			try {
				console.log("level > 0")
				window.PH = {};
				window.PH.actor = actor;
				window.PH.item = item;
				const spellFormData = await game.dnd5e.applications.AbilityUseDialog.create(item);
				lvl = spellFormData.get("level");
				consume = Boolean(spellFormData.get("consumeSlot"));
				placeTemplate = Boolean(spellFormData.get("placeTemplate"));
				// console.log(lvl, consume, placeTemplate);
			}
			catch(error) { return "error"; }
		}
		
		if (lvl == "pact") {
			isPact = true;
			lvl = getProperty(actor, `data.data.spells.pact.level`) || lvl;
		}
		
		if ( lvl !== item.data.data.level ) {
			item = item.constructor.createOwned(mergeObject(duplicate(item.data), {"data.level": lvl}, {inplace: false}), actor);
		}
		
		// Update Actor data
		if ( consume && (lvl !== 0) ) {
			let spellSlot = isPact ? "pact" : "spell"+lvl;
			const slots = parseInt(actor.data.data.spells[spellSlot].value);
	  if ( slots === 0 || Number.isNaN(slots) ) {
				ui.notifications.error(game.i18n.localize("DND5E.SpellCastNoSlots"));
				return "error";
			}
			await actor.update({
				[`data.spells.${spellSlot}.value`]: Math.max(parseInt(actor.data.data.spells[spellSlot].value) - 1, 0)
			});
		}
		
		if (placeTemplate) {
			this.placeTemplate();
		}
		
		return lvl;
	}
	
	// Places a template if the item has an area of effect
	placeTemplate() {
		let item = this.item;
		if (item.hasAreaTarget) {
			const template = game.dnd5e.canvas.AbilityTemplate.fromItem(item);
			if ( template ) template.drawPreview(event);
			if (item.actor && item.actor.sheet) {
				if (item.sheet.rendered) item.sheet.minimize();
				if (item.actor.sheet.rendered) item.actor.sheet.minimize();
			}
		}
	}
	
	// Consumes charges & resources assigned on an item.
	async consumeCharge() {
		let item = this.item,
			itemData = item.data.data;
		
		const hasUses = !!(itemData.uses.value || itemData.uses.max || itemData.uses.per); // Actual check to see if uses exist on the item, even if params.useCharge.use == true
		const hasResource = !!(itemData.consume?.target); // Actual check to see if a resource is entered on the item, even if params.useCharge.resource == true

		const request = this.params.useCharge; // Has bools for quantity, use, resource, and charge
		const recharge = itemData.recharge || {};
		const uses = itemData.uses || {};
		const autoDestroy = uses.autoDestroy;
		const current = uses.value || 0;
		const remaining = request.use ? Math.max(current - 1, 0) : current;
		const q = itemData.quantity;
		const updates = {};
		let output = "success";

		// Check for consuming uses, but not quantity
		if (hasUses && request.use && !request.quantity) {
			if (!current) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming quantity, but not uses
		if (request.quantity && !request.use) {
			if (!q) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming quantity and uses
		if (hasUses && request.use && request.quantity) {
			if (!current && q <= 1) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming charge ("Action Recharge")
		if (request.charge) {
			if (!recharge.charged) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming resource.
		// Note that _handleResourceConsumption() will actually consume the resource as well as perform the check, hence why it must be performed last.
		if (hasResource && request.resource) {
			const allowed = await item._handleResourceConsumption({isCard: true, isAttack: true});
			if (allowed === false) { return "error"; }
		}

		// Handle uses, but not quantity
		if (hasUses && request.use && !request.quantity) {
			updates["data.uses.value"] = remaining;
		}
		
		// Handle quantity, but not uses
		else if (request.quantity && !request.use) {
			if (q <= 1 && autoDestroy) {
				output = "destroy";
			}
			updates["data.quantity"] = q - 1;
		}

		// Handle quantity and uses
		else if (hasUses && request.use && request.quantity) {
			let remainingU = remaining;
			let remainingQ = q;
			console.log(remainingQ, remainingU);
			if (remainingU < 1) {
				remainingQ -= 1;
				ui.notifications.warn(game.i18n.format("br5e.error.autoDestroy", {name: item.name}));
				if (remainingQ >= 1) {
					remainingU = itemData.uses.max || 0;
				} else { remainingU = 0; }
				if (remainingQ < 1 && autoDestroy) { output = "destroy"; }
			}

			updates["data.quantity"] = Math.max(remainingQ,0);
			updates["data.uses.value"] = Math.max(remainingU,0);
		}

		// Handle charge ("Action Recharge")
		if (request.charge) {
			updates["data.recharge.charged"] = false;
		}

		item.update(updates);

		return output;
	}
}
