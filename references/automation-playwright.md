# אוטומציה — Playwright + Page Object Model

מתי להשתמש: כשהמשתמש מבקש להפוך בדיקות ידניות חוזרות לאוטומטיות, או לתעד סוויטת
אוטומציה קיימת. שפה מומלצת: TypeScript/JavaScript (זהה לסטאק הפרויקט, אפס תלות חדשה
מעבר ל-`@playwright/test`).

## מבנה פרויקט מומלץ

```
qa-automation/
├── playwright.config.ts        # baseURL, דפדפנים, רזולוציות, retries
├── pages/                      # Page Objects — כל מסך קובץ
│   ├── DashboardPage.ts
│   └── ResidentsPage.ts
├── tests/
│   ├── residents.spec.ts       # לפי מודול (תואם שדה module בדשבורד)
│   └── smoke.spec.ts
└── fixtures/testData.ts        # נתוני בדיקה — לא בתוך הבדיקות
```

## Page Object Model — הכללים

- **דף = מחלקה**; הבדיקה לא נוגעת בסלקטורים ישירות, רק בפעולות (`addResident(...)`)
  ובקריאות מצב (`getResidentCount()`).
- **locators כשדות**, פעולות כמתודות, בלי assertions בתוך ה-Page Object (הם שייכים
  לבדיקה).
- **סלקטורים יציבים**: עדיפות `getByRole`/`getByLabel`/`getByText` (עמידים לשינויי
  עיצוב); `data-testid` כשאין ברירה; לעולם לא XPath שביר או מחלקות CSS קוסמטיות.

```ts
// pages/ResidentsPage.ts
import { Page, Locator } from '@playwright/test';
export class ResidentsPage {
  readonly addBtn: Locator;
  readonly nameInput: Locator;
  constructor(private page: Page) {
    this.addBtn = page.getByRole('button', { name: 'הוסף דייר' });
    this.nameInput = page.getByLabel('שם');
  }
  async goto() { await this.page.goto('/'); /* + ניווט לטאב */ }
  async addResident(name: string, apt: string) { /* פעולה שלמה אחת */ }
}
```

```ts
// tests/residents.spec.ts
test('הוספת דייר עם גרש בשם לא שוברת שמירה', async ({ page }) => {
  const residents = new ResidentsPage(page);
  await residents.goto();
  await residents.addResident("ז'קלין או'קונור", '4');
  await expect(residents.rowByName("ז'קלין או'קונור")).toBeVisible();
});
```

## עקרונות שנגזרים מכללי הסקיל
- **בדיקות שליליות באוטומציה** — כל spec כולל גם קלט ריק/עוין (כלל 4c חל גם כאן);
  סוויטה שכולה happy paths נותנת ביטחון כוזב.
- **RTL ועברית** — הקלד עברית אמיתית בבדיקות (לא lorem); בדוק שהטקסט נשמר ומוצג
  (זה בדיוק סוג הבאגים שנתפסו בפרויקט הזה — קידוד).
- **בלי waits שרירותיים** — `await expect(...).toBeVisible()` עם auto-wait, לא
  `waitForTimeout`.
- **עצמאות** — כל בדיקה מקימה את הנתונים שלה (או טוענת נתוני דמו) ולא תלויה בסדר.

## תיעוד ריצה חזרה לדשבורד
ריצת אוטומציה = הרצת checks: על כל spec שנכשל נפתח check עם `result:"fail"` והדוח
בתבנית bug-reporting.md (כולל שם ה-spec והשגיאה). ריצה ירוקה נרשמת כ-check אחד
מסכם ("סוויטת residents — N בדיקות עברו") — לא N רשומות.
