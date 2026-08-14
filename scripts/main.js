
/**
 * Merchant Shop
 * Foundry VTT v14 + D&D 5e 5.3.3
 *
 * GM workflow:
 * 1. Put Items into the NPC Actor's inventory.
 * 2. Right-click the NPC token -> "ตั้ง/ยกเลิกพ่อค้า".
 * 3. Players click/select the merchant token to open the shop.
 *
 * Item price is read from the D&D 5e Item's system.price.value/currency.
 * Stock is unlimited in this simple version.
 */

const MODULE_ID = "merchant-shop";
const FLAG_MERCHANT = "merchant";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    ui.notifications.warn("Merchant Shop ต้องใช้กับระบบ D&D 5e");
  }
});

/**
 * Right-click context menu on Token.
 * Adds easy GM controls without modifying the D&D5e Actor Sheet.
 */
Hooks.on("getTokenPlaceableContextOptions", (application, menuItems) => {
  menuItems.push({
    name: "ตั้ง/ยกเลิกพ่อค้า",
    icon: '<i class="fas fa-store"></i>',
    condition: () => game.user.isGM,
    callback: async (li) => {
      const token = application.object;
      const actor = token?.actor;
      if (!actor) return;
      const enabled = !actor.getFlag(MODULE_ID, FLAG_MERCHANT);
      await actor.setFlag(MODULE_ID, FLAG_MERCHANT, enabled);
      ui.notifications.info(`${actor.name}: ${enabled ? "เปิดเป็นร้านค้าแล้ว" : "ยกเลิกสถานะร้านค้าแล้ว"}`);
    }
  });

  menuItems.push({
    name: "เปิดร้านค้า",
    icon: '<i class="fas fa-coins"></i>',
    condition: () => Boolean(application.object?.actor?.getFlag(MODULE_ID, FLAG_MERCHANT)),
    callback: () => openShop(application.object.actor)
  });
});

/**
 * When a token is controlled, open its shop if it is a merchant.
 * This gives the user the simple "click NPC -> shop" behavior.
 */
Hooks.on("controlToken", (token, controlled) => {
  if (!controlled) return;
  const actor = token?.actor;
  if (!actor?.getFlag(MODULE_ID, FLAG_MERCHANT)) return;

  // Prevent accidental opening when GM is using the token for editing.
  if (game.user.isGM && game.keyboard?.isShift) return;
  openShop(actor);
});

async function openShop(merchant) {
  if (!merchant) return;

  const items = merchant.items.contents.filter(item => {
    // Skip items explicitly marked as not for sale.
    return item.getFlag(MODULE_ID, "forSale") !== false;
  });

  const itemRows = items.map(item => {
    const price = getPrice(item);
    const disabled = !price || price.total <= 0;
    const priceText = price ? `${formatNumber(price.total)} ${price.currency.toUpperCase()}` : "ไม่มีราคา";
    const img = item.img || "icons/svg/item-bag.svg";
    return `
      <div class="ms-item" data-item-id="${item.id}">
        <img src="${img}" alt="">
        <div class="ms-item-main">
          <div class="ms-item-name">${escapeHtml(item.name)}</div>
          <div class="ms-item-meta">${priceText}</div>
        </div>
        <button type="button" class="ms-buy" data-item-id="${item.id}" ${disabled ? "disabled" : ""}>
          ซื้อ
        </button>
      </div>`;
  }).join("");

  const content = `
    <div class="merchant-shop">
      <div class="ms-header">
        <div>
          <h2>${escapeHtml(merchant.name)}</h2>
          <p>รายการสินค้าของพ่อค้า</p>
        </div>
      </div>
      <div class="ms-search-wrap">
        <input type="search" class="ms-search" placeholder="ค้นหาสินค้า...">
      </div>
      <div class="ms-items">
        ${itemRows || '<div class="ms-empty">ร้านค้านี้ยังไม่มีสินค้า</div>'}
      </div>
    </div>`;

  const { DialogV2 } = foundry.applications.api;
  const dialog = new DialogV2({
    window: { title: `${merchant.name} — ร้านค้า`, frame: true },
    classes: ["merchant-shop-dialog"],
    content,
    buttons: [{
      action: "close",
      label: "ปิด",
      icon: "fas fa-times"
    }],
    render: (event) => {
      const html = event.target;
      html.querySelectorAll(".ms-buy").forEach(button => {
        button.addEventListener("click", async () => {
          const item = merchant.items.get(button.dataset.itemId);
          if (!item) return;
          await buyItem(merchant, item);
          // Re-open to refresh current player money / state.
          dialog.close();
          openShop(merchant);
        });
      });
      html.querySelector(".ms-search")?.addEventListener("input", (ev) => {
        const q = ev.target.value.trim().toLowerCase();
        html.querySelectorAll(".ms-item").forEach(row => {
          row.hidden = q && !row.querySelector(".ms-item-name")?.textContent.toLowerCase().includes(q);
        });
      });
    }
  });
  await dialog.render(true);
}

async function buyItem(merchant, item) {
  const buyer = game.user.character;
  if (!buyer) {
    ui.notifications.warn("คุณต้องเลือก Character ของตัวเองก่อนจึงจะซื้อของได้");
    return;
  }

  const price = getPrice(item);
  if (!price || price.total <= 0) {
    ui.notifications.warn(`${item.name} ไม่มีราคาที่ระบบร้านค้ารองรับ`);
    return;
  }

  const quantity = 1;
  const total = price.total * quantity;

  const ok = await confirmPurchase(item, price, quantity, total);
  if (!ok) return;

  const currency = foundry.utils.deepClone(buyer.system.currency ?? {});
  const current = Number(currency[price.currency] ?? 0);

  if (current < total) {
    ui.notifications.error(`เงินไม่พอ: ต้องใช้ ${formatNumber(total)} ${price.currency.toUpperCase()}`);
    return;
  }

  currency[price.currency] = current - total;

  try {
    await buyer.update({ "system.currency": currency });
    const data = item.toObject();
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data.ownership;
    delete data.effects; // effects are embedded below on modern documents; recreate from full object if present
    const existing = buyer.items.find(i => i.name === item.name && i.type === item.type);

    if (existing && typeof existing.system?.quantity === "number") {
      await existing.update({ "system.quantity": Number(existing.system.quantity) + quantity });
    } else {
      // Preserve embedded effects if they exist by removing only document metadata.
      const fullData = item.toObject();
      delete fullData._id;
      await buyer.createEmbeddedDocuments("Item", [fullData]);
    }

    ui.notifications.info(`ซื้อ ${item.name} สำเร็จ — ${formatNumber(total)} ${price.currency.toUpperCase()}`);
  } catch (err) {
    console.error(`${MODULE_ID} | Purchase failed`, err);
    ui.notifications.error("การซื้อไม่สำเร็จ ดู Console (F12) เพื่อดูรายละเอียด");
    // Best-effort refund if item creation/update failed after currency update.
    try {
      const refund = foundry.utils.deepClone(buyer.system.currency ?? {});
      refund[price.currency] = Number(refund[price.currency] ?? 0) + total;
      await buyer.update({ "system.currency": refund });
    } catch (refundErr) {
      console.error(`${MODULE_ID} | Refund failed`, refundErr);
    }
  }
}

async function confirmPurchase(item, price, quantity, total) {
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.confirm({
    window: { title: "ยืนยันการซื้อ" },
    content: `
      <div class="ms-confirm">
        <img src="${item.img || "icons/svg/item-bag.svg"}" alt="">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <div>จำนวน: ${quantity}</div>
          <div>ราคารวม: <b>${formatNumber(total)} ${price.currency.toUpperCase()}</b></div>
        </div>
      </div>`,
    yes: { label: "ซื้อ", icon: "fas fa-shopping-cart" },
    no: { label: "ยกเลิก", icon: "fas fa-times" }
  });
  return result;
}

function getPrice(item) {
  const p = item.system?.price;
  if (!p) return null;
  const currency = String(p.currency ?? "gp").toLowerCase();
  const value = Number(p.value ?? 0);
  if (!Number.isFinite(value)) return null;
  return { total: value, currency };
}

function formatNumber(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
