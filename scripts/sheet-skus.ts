/**
 * The EXACT pre-filled SKUs + pack sizes from the 7 paper ops sheets.
 * These are the operational source of truth and WIN over the eat-os seed for
 * channel + pack size. Codes are kept verbatim (incl. the "EAT046- BF" space);
 * the seeder normalizes them. Pack text is verbatim from the Excel.
 */
export type SheetSku = {
  code: string;
  name: string;
  channel: "BULK_FRUIT" | "BLINKIT" | "SPENCERS";
  packText: string | null;
};

export const SHEET_SKUS: SheetSku[] = [
  // ---- DC ASSEMBLY BULK FRUIT (-BF) — no fixed pack size ----
  { code: "EAT046- BF", name: "Dragon- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT069- BF", name: "Grapefruits- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT113- BF", name: "Orange Malta- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT127- BF", name: "Orange Mandarin- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT140- BF", name: "Pear Beauti Red- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT176- BF", name: "Pear Beauti Green- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT182- BF", name: "Apple Royal Gala- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT219- BF", name: "Kiwi Gold Zespri- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT228- BF", name: "Apple Pink Lady- B", channel: "BULK_FRUIT", packText: null },
  { code: "EAT247- BF", name: "Avocado Hass-22C", channel: "BULK_FRUIT", packText: null },
  { code: "EAT259- BF", name: "Apple Brazil Gala(150 count)- B", channel: "BULK_FRUIT", packText: null },

  // ---- DC ASSEMBLY BLINKIT (BZ) ----
  { code: "EAT011BZ", name: "Italian Basil Leaves Pack -BZ", channel: "BLINKIT", packText: "50 g" },
  { code: "EAT024BZ", name: "Broccoli Pack -BZ", channel: "BLINKIT", packText: "1pc (200 - 300 g)" },
  { code: "EAT040BZ", name: "Chinese Cabbage Pack -BZ", channel: "BLINKIT", packText: "1pc (400-700 g)" },
  { code: "EAT041BZ", name: "Coriander Bunch Pack -BZ", channel: "BLINKIT", packText: "100 g" },
  { code: "EAT045BZ", name: "Cherry Tomatoes Pack -BZ", channel: "BLINKIT", packText: "200 g" },
  { code: "EAT046BZ", name: "Dragon Fruit Pack -BZ", channel: "BLINKIT", packText: "1pc (300 - 400 g)" },
  { code: "EAT055BZ", name: "English Cucumber Pack -BZ", channel: "BLINKIT", packText: "500 - 600 g" },
  { code: "EAT066BZ", name: "Shimeji Mushroom White Pack -BZ", channel: "BLINKIT", packText: "125 g" },
  { code: "EAT077BZ", name: "Green Zucchini Pack -BZ", channel: "BLINKIT", packText: "1pc (200 - 250 g)" },
  { code: "EAT080BZ", name: "Fresh Rosemary -BZ", channel: "BLINKIT", packText: "10 g" },
  { code: "EAT099BZ", name: "Green lettuce Pack -BZ", channel: "BLINKIT", packText: "1 unit (100 g)" },
  { code: "EAT125BZ", name: "Mint Leaves Pack -BZ", channel: "BLINKIT", packText: "100 g" },
  { code: "EAT162BZ", name: "Red Cabbage Pack -BZ", channel: "BLINKIT", packText: "1pc (300 -500 g)" },
  { code: "EAT166BZ", name: "Red Bell Pepper Pack -BZ", channel: "BLINKIT", packText: "1pc (125 - 175 g)" },
  { code: "EAT174BZ", name: "Shimeji Mushroom Brown Pack -BZ", channel: "BLINKIT", packText: "125 g" },
  { code: "EAT176BZ", name: "Packham Pear South Africa Pack -BZ", channel: "BLINKIT", packText: "2pc (300 - 350 g)" },
  { code: "EAT203BZ", name: "Fresh Thyme -BZ", channel: "BLINKIT", packText: "10 g" },
  { code: "EAT207BZ", name: "Yellow Bell Pepper Pack -BZ", channel: "BLINKIT", packText: "1pc (125 - 175 g)" },
  { code: "EAT208BZ", name: "Yellow Zucchini Pack -BZ", channel: "BLINKIT", packText: "1pc (200 - 250 g)" },
  { code: "EAT219BZ", name: "Sungold Kiwi 2 Pieces -BZ", channel: "BLINKIT", packText: "2pc" },
  { code: "EAT228BZ", name: "Pink Lady Apple 2 Pieces -BZ", channel: "BLINKIT", packText: "2pc (300 - 400 g)" },
  { code: "EAT261BZ", name: "Mix Cherry Tomatoes -BZ", channel: "BLINKIT", packText: "100 g" },
  { code: "EAT262BZ", name: "Assorted Capsicum Pack -BZ", channel: "BLINKIT", packText: "1 unit" },

  // ---- DC ASSEMBLY SPENCER'S (S) ----
  { code: "EAT007S", name: "Baby Corn Pack -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT021S", name: "Blueberry- Indian -S", channel: "SPENCERS", packText: "100 g" },
  { code: "EAT024S", name: "Broccoli PC -S", channel: "SPENCERS", packText: "1pc (250 g)" },
  { code: "EAT028S", name: "Mushroom Button -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT033S", name: "Celery PC -S", channel: "SPENCERS", packText: "1pc (200 g)" },
  { code: "EAT040S", name: "Exotic Cabbage kg -S", channel: "SPENCERS", packText: "700 g" },
  { code: "EAT041S", name: "Coriander PC -S", channel: "SPENCERS", packText: "100 g" },
  { code: "EAT045S", name: "Cherry Tomato Pack -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT055S", name: "English Cucumber -S", channel: "SPENCERS", packText: "500 g" },
  { code: "EAT074S", name: "Sweet Corn PC -S", channel: "SPENCERS", packText: "1pc" },
  { code: "EAT077S", name: "Zucchini Green -S", channel: "SPENCERS", packText: "1pc (200 g)" },
  { code: "EAT084S", name: "Iceberg Lettuce Kg -S", channel: "SPENCERS", packText: "250 g" },
  { code: "EAT093S", name: "Leek Fresh -S", channel: "SPENCERS", packText: "100 g" },
  { code: "EAT099S", name: "Lettuce PC -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT105S", name: "Alphonso Mango - S", channel: "SPENCERS", packText: "6pcs" },
  { code: "EAT122S", name: "Moong Bean Sprout Pack -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT123S", name: "Sprout Horse Gram Pack -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT125S", name: "Mint -S", channel: "SPENCERS", packText: "50g" },
  { code: "EAT141S", name: "Parsley -S", channel: "SPENCERS", packText: "100 g" },
  { code: "EAT162S", name: "Red Cabbage Kg -S", channel: "SPENCERS", packText: "1pc (250 g)" },
  { code: "EAT166S", name: "Bell Pepper Red -S", channel: "SPENCERS", packText: "1pc (125 g)" },
  { code: "EAT169S", name: "Capsicum Coloured PC -S", channel: "SPENCERS", packText: "2pc (250 g)" },
  { code: "EAT183S", name: "Sun Melon Kg", channel: "SPENCERS", packText: null },
  { code: "EAT186S", name: "Sweet Corn American -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT207S", name: "Bell Pepper Yellow -S", channel: "SPENCERS", packText: "1pc (125 g)" },
  { code: "EAT208S", name: "Zucchini Yellow -S", channel: "SPENCERS", packText: "1pc (250 g)" },
  { code: "EAT235S", name: "Musk Melon kg -S", channel: "SPENCERS", packText: null },
  { code: "EAT245S", name: "Sprout Mix Pack -S", channel: "SPENCERS", packText: "200 g" },
  { code: "EAT258S", name: "Curry Leaves PC -S", channel: "SPENCERS", packText: "100 g" },
];
