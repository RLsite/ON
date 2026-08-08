# מדריך ארכיטקטורת Page Object Model (POM) ב-TypeScript

תבנית העיצוב **Page Object Model (POM)** היא סטנדרט התעשייה לכתיבת קוד בדיקות אוטומטי יציב, קריא וקל לתחזוקה. מסמך זה מסביר את עקרונות ה-POM ומציג דוגמאות קוד מלאות ב-TypeScript עבור פרויקט הבדיקות שלנו ב-Playwright.

---

## 1. מהו Page Object Model ולמה להשתמש בו?

בעולם בדיקות ה-Web, דפי האפליקציה משתנים לעיתים קרובות: מזהי אלמנטים (IDs, Classes) מתעדכנים, עיצובים משתנים ותזרימים עסקיים משתפרים.

אם נכתוב את הבדיקות שלנו בצורה "ישירה" (inline locators) שבה כל קובץ בדיקה מכיל את מזהי האלמנטים של הדפדפן, נגלה מהר מאוד שכל שינוי קטן בקוד האפליקציה שובר עשרות בדיקות שונות.

### היתרונות של שימוש ב-POM:
1. **מניעת כפל קוד (DRY - Don't Repeat Yourself):** מזהה האלמנט והמתודות מוגדרים פעם אחת בלבד במחלקת ה-Page Object, וכל קובצי הבדיקות משתמשים בהם.
2. **קריאות משופרת (Readability):** קוד הבדיקה (ה-Test file) נראה כמו רשימה של שלבים עסקיים לוגיים ולא כמו אוסף של פקודות דפדפן טכניות.
3. **תחזוקה קלה (Easy Maintenance):** במידה ושם כפתור משתנה, השינוי מתבצע במקום אחד בלבד (בתוך מחלקת ה-Page המיועדת) והבדיקות ממשיכות לעבוד כרגיל.

---

## 2. מבנה תיקיות מומלץ (Folder Structure)

```text
tests/
├── pages/                           # כאן יושבים ה-Page Objects
│   ├── base.page.ts                 # מחלקת הבסיס שממנה יורשים שאר הדפים
│   ├── login.page.ts
│   ├── home.page.ts
│   └── checkout.page.ts
└── e2e/                             # כאן יושבות הבדיקות עצמן
    └── checkout-flow.spec.ts
```

---

## 3. מחלקת הבסיס (Base Page Class)

כל דף אינטרנט באפליקציה שלנו יירש ממחלקת בסיס משותפת בשם `BasePage`. מחלקה זו מכילה פונקציונליות וקישורים המשותפים לכלל הדפים (כגון ניווט, קבלת ה-URL הנוכחי, ומתודות עזר כלליות).

### קוד מחלקת הבסיס (`tests/pages/base.page.ts`):

```typescript
import { Page, Locator } from '@playwright/test';

export class BasePage {
  protected readonly page: Page;
  public readonly footerCopyright: Locator;

  constructor(page: Page) {
    this.page = page;
    // אלמנט משותף הקיים בכל הדפים בתחתית העמוד
    this.footerCopyright = page.locator('footer .copyright');
  }

  /**
   * ניווט לכתובת יחסית בהתאם ל-Base URL המוגדר בקונפיגורציה
   * @param path הניתוב היחסי (למשל: '/login')
   */
  async navigateToPath(path: string): Promise<void> {
    await this.page.goto(path);
  }

  /**
   * מקבלת את ה-URL הנוכחי של הדפדפן
   */
  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  /**
   * ממתינה לטעינה מלאה של ה-Network (לשימוש במקרי קצה)
   */
  async waitForNetworkIdle(): Promise<void> {
    await this.page.waitForLoadState('networkidle');
  }
}
```

---

## 4. דוגמאות למחלקות דף (Example Page Objects)

להלן שלוש מחלקות דף המייצגות תהליך רכישה קלאסי: התחברות (Login), דף הבית ובחירת מוצר (Home), ודף התשלום (Checkout).

### א. דף ההתחברות (`tests/pages/login.page.ts`):

```typescript
import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  public readonly emailInput: Locator;
  public readonly passwordInput: Locator;
  public readonly loginButton: Locator;
  public readonly errorMessage: Locator;

  constructor(page: Page) {
    // קריאה ל-Constructor של מחלקת האב BasePage
    super(page);

    // שימוש בלוקייטורים מומלצים ומבוססי נגישות
    this.emailInput = page.getByRole('textbox', { name: 'אימייל' });
    this.passwordInput = page.getByRole('textbox', { name: 'סיסמה' });
    this.loginButton = page.getByRole('button', { name: 'התחבר' });
    this.errorMessage = page.locator('.error-message-alert');
  }

  /**
   * ניווט ישיר לדף ההתחברות
   */
  async navigateTo(): Promise<void> {
    await this.navigateToPath('/login');
  }

  /**
   * ביצוע תהליך התחברות מלא
   * @param email כתובת איมייל
   * @param password סיסמה
   */
  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}
```

### ב. דף הבית ורשימת מוצרים (`tests/pages/home.page.ts`):

```typescript
import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class HomePage extends BasePage {
  public readonly welcomeHeader: Locator;
  public readonly productCards: Locator;
  public readonly cartIcon: Locator;

  constructor(page: Page) {
    super(page);

    this.welcomeHeader = page.getByRole('heading', { level: 1 });
    this.productCards = page.locator('.product-card');
    this.cartIcon = page.locator('.shopping-cart-badge');
  }

  /**
   * מוסיף מוצר ספציפי לעגלה לפי השם שלו
   * @param productName שם המוצר כפי שמופיע בכרטיסייה
   */
  async addProductToCart(productName: string): Promise<void> {
    // מציאת כרטיסיית המוצר הספציפית המכילה את השם
    const targetProductCard = this.page
      .locator('.product-card')
      .filter({ hasText: productName });

    // לחיצה על כפתור ההוספה לעגלה בתוך כרטיסיית המוצר
    const addToCartButton = targetProductCard.getByRole('button', { name: 'הוסף לעגלה' });
    await addToCartButton.click();
  }

  /**
   * מעבר לדף התשלום (Checkout) על ידי לחיצה על האייקון של העגלה
   */
  async goToCart(): Promise<void> {
    await this.cartIcon.click();
  }
}
```

### ג. דף התשלום והקופה (`tests/pages/checkout.page.ts`):

```typescript
import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class CheckoutPage extends BasePage {
  public readonly fullNameInput: Locator;
  public readonly addressInput: Locator;
  public readonly creditCardInput: Locator;
  public readonly submitPaymentButton: Locator;
  public readonly successOrderMessage: Locator;

  constructor(page: Page) {
    super(page);

    this.fullNameInput = page.getByPlaceholder('שם מלא');
    this.addressInput = page.getByPlaceholder('כתובת למשלוח');
    this.creditCardInput = page.locator('input#credit-card-number');
    this.submitPaymentButton = page.getByRole('button', { name: 'בצע הזמנה' });
    this.successOrderMessage = page.locator('.order-success-confirmation');
  }

  /**
   * מילוי פרטי משלוח ותשלום וביצוע הרכישה
   */
  async completeCheckout(name: string, address: string, ccNumber: string): Promise<void> {
    await this.fullNameInput.fill(name);
    await this.addressInput.fill(address);
    await this.creditCardInput.fill(ccNumber);
    await this.submitPaymentButton.click();
  }
}
```

---

## 5. פרקטיקות מומלצות לכתיבת קוד POM (Best Practices)

1. **אל תעשו Assertions בתוך ה-Page Object!**
   התפקיד של ה-Page Object הוא לתאר את הדף ולספק פונקציות לביצוע פעולות עליו. הבדיקות עצמן (`*.spec.ts`) הן אלו שאמורות לבצע את ה-Assertions (הנחות האימות כגון `expect`). החרגה יחידה היא אימות של מעבר דף או טעינת אלמנט הכרחי להמשכיות הפעולה.
2. **החזירו לוקייטורים (Locators), אל תחזירו ערכים טקסטואליים גולמיים:**
   במקום לכתוב פונקציה כמו `async getWelcomeMessage()` שמחזירה string, עדיף לחשוף משתנה מסוג `Locator` (למשל `this.welcomeHeader`). זה מאפשר לכתוב בבדיקה בדיקות יציבות של Playwright כמו `await expect(homePage.welcomeHeader).toContainText('שלום')`, המשתמשות במנגנוני ה-Auto-retry המובנים.
3. **שימוש נכון ב-Locators יציבים:**
   העדיפו תמיד שימוש ב-Locators מבוססי תפקיד (Role) או Test IDs, והימנעו כמה שניתן מסלקטורים שבירים של CSS או XPath מורכב.
4. **עקרון הממשק הזורם (Fluent API - אופציונלי):**
   ניתן להגדיר שפעולות שמנווטות לדף אחר יחזירו מופע חדש של אותו דף. לדוגמה:
   ```typescript
   async clickLogin(page: Page): Promise<HomePage> {
     await this.loginButton.click();
     return new HomePage(page);
   }
   ```

---

## 6. דוגמה לבדיקת קצה לקצה מלאה ושלמה (Full E2E Test Example)

להלן האופן שבו כל החלקים מתחברים יחד לבדיקת קצה לקצה חלקה, מובנת ונקייה המדמה תהליך רכישה שלם של משתמש.

### קובץ הבדיקה (`tests/e2e/checkout-flow.spec.ts`):

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
import { HomePage } from '../pages/home.page';
import { CheckoutPage } from '../pages/checkout.page';

test.describe('תהליך רכישה מקצה לקצה (End-to-End E-Commerce Flow)', () => {
  let loginPage: LoginPage;
  let homePage: HomePage;
  let checkoutPage: CheckoutPage;

  test.beforeEach(async ({ page }) => {
    // אתחול מחלקות ה-Page Objects עבור כל בדיקה
    loginPage = new LoginPage(page);
    homePage = new HomePage(page);
    checkoutPage = new CheckoutPage(page);

    // שלב הכנה: כניסה לדף ההתחברות
    await loginPage.navigateTo();
  });

  test('משתמש רשום מסוגל לבצע רכישת מוצר בהצלחה', async ({ page }) => {
    // שלב 1: התחברות למערכת
    await test.step('התחברות למערכת עם משתמש תקין', async () => {
      await loginPage.login('qa_user@example.com', 'SuperSecret123!');
      await expect(homePage.welcomeHeader).toBeVisible();
    });

    // שלב 2: בחירת מוצר והוספתו לעגלה
    await test.step('בחירת מוצר והוספה לעגלה', async () => {
      await homePage.addProductToCart('iPhone 15 Pro');
      await expect(homePage.cartIcon).toContainText('1'); // אימות שיש מוצר אחד בעגלה
      await homePage.goToCart();
    });

    // שלב 3: מילוי פרטים וביצוע תשלום בקופה
    await test.step('ביצוע צ׳קאאוט ותשלום בקופה', async () => {
      await checkoutPage.completeCheckout(
        'ישראל ישראלי',
        'הרצל 100, תל אביב',
        '4580123456789012'
      );
      
      // אימות סופי שההזמנה בוצעה בהצלחה
      await expect(checkoutPage.successOrderMessage).toBeVisible();
      await expect(checkoutPage.successOrderMessage).toContainText('תודה רבה! הזמנתך התקבלה בהצלחה');
    });
  });
});
```
