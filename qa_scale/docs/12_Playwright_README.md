# מדריך לפרויקט בדיקות האוטומציה - Playwright Test Suite

פרויקט זה מכיל את חליפת בדיקות האוטומציה מקצה לקצה (End-to-End) עבור מערכות ה-Web שלנו, תוך שימוש ב-**Playwright** ו-**TypeScript**.

---

## 1. מבנה הפרויקט (Project Structure)

המבנה תוכנן לפי עקרון ה-Page Object Model (POM) להפרדה מלאה בין הבדיקות לבין האלמנטים בדף.

```text
qa_scale/
├── docs/                             # מסמכי אסטרטגיה ומדריכים
├── playwright.config.ts              # קובץ הקונפיגורציה הראשי של Playwright
├── package.json                      # תלויות וסקריפטים להרצה
└── tests/                            # תיקיית הבדיקות והתשתית
    ├── e2e/                          # קובצי הבדיקות (Spec files)
    │   ├── login.spec.ts
    │   └── checkout.spec.ts
    ├── pages/                        # מחלקות ה-Page Objects
    │   ├── base.page.ts
    │   ├── login.page.ts
    │   ├── home.page.ts
    │   └── checkout.page.ts
    ├── utils/                        # פונקציות עזר (API, DB, Test Data)
    │   └── test-data-generator.ts
    └── fixtures/                     # הגדרות Fixtures מותאמים אישית
        └── custom-fixture.ts
```

---

## 2. שלבי התקנה ודרישות קדם (Installation & Prerequisites)

### דרישות קדם:
* התקנת **Node.js** (גרסה 18 ומעלה מומלצת).
* מומלץ להשתמש ב-**VS Code** כסביבת פיתוח עם התוסף הרשמי: **Playwright Test for VS Code**.

### שלבי התקנה:
1. שכפל את הפרויקט (Clone) למחשב המקומי.
2. בצע התקנה של כל חבילות ה-NPM הנדרשות:
   ```bash
   npm install
   ```
3. התקן את הדפדפנים הנתמכים על ידי Playwright והתלויות של מערכת ההפעלה:
   ```bash
   npx playwright install --with-deps
   ```

---

## 3. קובץ קונפיגורציה (playwright.config.ts)

להלן הגדרת הבסיס המומלצת עבור הפרויקט שלנו, התומכת בריבוי דפדפנים, הרצה מקבילית, דוחות והקלטות במקרה של כישלון:

```typescript
import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

// טעינת משתני סביבה מקובץ .env
dotenv.config();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true, // הרצה מקבילית מלאה של בדיקות
  forbidOnly: !!process.env.CI, // חסימת commit של test.only ב-CI
  retries: process.env.CI ? 2 : 0, // הגדרת ניסיונות הרצה חוזרים בכישלון
  workers: process.env.CI ? 4 : undefined, // כמות תהליכונים מקבילים
  reporter: [
    ['html', { open: 'never' }],
    ['allure-playwright']
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://sandbox.example.com',
    trace: 'on-first-retry', // הקלטת Trace רק אם הבדיקה נכשלה בפעם הראשונה
    screenshot: 'only-on-failure', // צילום מסך רק בכישלון
    video: 'retain-on-failure', // שמירת וידאו רק בכישלון
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
```

---

## 4. כיצד להריץ בדיקות (How to Run Tests)

ניתן להריץ את הבדיקות באמצעות שורת הפקודה באופן מקומי או במסגרת תהליכי ה-CI/CD.

### הרצה מקומית:
* **הרצת כל הבדיקות בכל הדפדפנים:**
  ```bash
  npx playwright test
  ```
* **הרצה בדפדפן ספציפי (למשל Chromium):**
  ```bash
  npx playwright test --project=chromium
  ```
* **הרצה במצב ממשק גרפי (UI Mode - מומלץ לפיתוח ודיבאג):**
  ```bash
  npx playwright test --ui
  ```
* **הרצה של קובץ בדיקות ספציפי:**
  ```bash
  npx playwright test tests/e2e/login.spec.ts
  ```
* **הרצה במצב Debug שורה-אחר-שורה:**
  ```bash
  npx playwright test --debug
  ```

---

## 5. כיצד לכתוב בדיקה חדשה (How to Write a New Test)

כאשר כותבים בדיקה חדשה, תמיד נשתמש בתבנית ה-Page Object Model. הנה דוגמה פשוטה לכתיבת בדיקה עבור תזרים התחברות למערכת.

### דוגמה לקובץ בדיקה (`tests/e2e/login.spec.ts`):

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
import { HomePage } from '../pages/home.page';

test.describe('תזרים התחברות למערכת (Authentication Flows)', () => {
  let loginPage: LoginPage;
  let homePage: HomePage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    homePage = new HomePage(page);
    await loginPage.navigateTo();
  });

  test('התחברות מושגת בהצלחה עם פרטים תקינים', async () => {
    // שלבי הבדיקה באמצעות מתודות עסקיות של ה-Page Objects
    await loginPage.login('user@example.com', 'SecurePassword123!');
    
    // בדיקת Assertions לוודא מעבר לדף הבית וזיהוי המשתמש
    await expect(homePage.welcomeHeader).toBeVisible();
    await expect(homePage.welcomeHeader).toContainText('ברוך הבא, user@example.com');
  });

  test('שגיאה מוצגת בהזנת סיסמה לא נכונה', async () => {
    await loginPage.login('user@example.com', 'wrongPassword');
    
    // אימות הופעת הודעת השגיאה המתאימה
    await expect(loginPage.errorMessage).toBeVisible();
    await expect(loginPage.errorMessage).toContainText('שם המשתמש או הסיסמה אינם נכונים');
  });
});
```

---

## 6. הסבר על תבנית Page Object Model (POM)

תבנית ה-POM מייצגת כל דף או קומפוננטה מרכזית באפליקציה כמחלקה (Class) ייעודית.
* **הסלקטורים (Locators)** מוגדרים ב-Constructor של המחלקה.
* **הפעולות (Methods)** מוגדרות כפונקציות עסקיות (למשל, פונקציית `login` שמקבלת שם וסיסמה ומבצעת מילוי טופס ולחיצה).
* היתרון המרכזי: אם מעצב המערכת ישנה את ה-ID של כפתור ההתחברות, נצטרך לתקן אותו **במקום אחד בלבד** (בקובץ ה-Page Object) ולא בעשרות קובצי בדיקות שונים.

*(להרחבה בנושא קוד ה-POM ודוגמאות מפורטות, פנו לקובץ `14_Page_Object_Model_Guide.md`)*.

---

## 7. הפקת דוחות (Reporting)

לאחר הרצת הבדיקות, ניתן להציג דוחות מפורטים שיעזרו לנו להבין מה נכשל ולמה.

### HTML Report (מובנה ב-Playwright):
מתאים מאוד להרצה מקומית. הוא מייצר קובץ HTML עצמאי המאפשר לראות כל שלב בבדיקה, זמני הרצה, צילומי מסך וסרטונים.
להצגת הדוח האחרון שהורץ:
```bash
npx playwright show-report
```

### Allure Report (דוח מתקדם):
מתאים לאינטגרציה ב-CI/CD ולהצגת מגמות לאורך זמן.
1. הפקדת תוצאות הרצה בפורמט Allure (מיוצר אוטומטית בהרצה בזכות הקונפיגורציה).
2. יצירה והצגה של הדוח:
   ```bash
   npm run allure:generate
   npm run allure:open
   ```

---

## 8. טיפים לניפוי שגיאות (Debugging Tips)

1. **שימוש ב-Playwright Inspector:**
   הרצת בדיקה עם הדגל `--debug` תפתח כלי ייעודי המאפשר לעבור על הבדיקה שורה אחר שורה, לראות את הדפדפן בפעולה ולבדוק אילו לוקייטורים מזוהים בזמן אמת.
2. **שימוש ב-Playwright Trace Viewer:**
   הכלי החזק ביותר של Playwright. הוא מתעד כל פעולה, אירוע ברשת (Network Calls), Console Logs, וצילומי מצב של ה-DOM לפני ואחרי כל פעולה.
   לפתיחת Trace שהוקלט במהלך ריצה שנכשלה:
   ```bash
   npx playwright show-trace path/to/trace.zip
   ```
3. **הדפסת לוגים לדפדפן:**
   עקבו אחר קריאות ה-Console של הדפדפן כדי לראות אם יש שגיאות JS פנימיות באפליקציה שגרמו לכישלון הבדיקה.

---

## 9. הגדרת משתני סביבה (Environment Variables)

לפני הרצת הבדיקות, יש ליצור קובץ בשם `.env` בתיקיית השורש של פרויקט הבדיקות (אין להעלות קובץ זה ל-Git!).

דוגמה לתוכן קובץ `.env`:
```env
BASE_URL=https://staging.example.com
TEST_USER_EMAIL=qa_tester@example.com
TEST_USER_PASSWORD=MySecretPassword123!
```
בתוך קוד הבדיקות או הקונפיגורציה, ניגש למשתנים אלו באמצעות: `process.env.TEST_USER_EMAIL`.
