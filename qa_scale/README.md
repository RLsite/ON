# QA Scale — ערכת תיעוד QA מקיפה לאתרים

> ערכת מסמכים מקצועית ומלאה לניהול בדיקות איכות (QA) לאתרי אינטרנט ואפליקציות ווב.

## סקירה כללית

ערכה זו מכסה את מלוא מחזור החיים של בדיקות QA — משלב אפיון הדרישות (PRD), דרך סקירת עיצובים (Figma), תכנון בדיקות, כתיבת תרחישים, דיווח באגים, דוחות הרצה, ועד לאוטומציה ושחרור גרסה.

## מפת קבצים

| # | קובץ | תיאור |
|---|------|-------|
| 00 | `00_QA_Kickoff_Guide.md` | מדריך התחלה — ניתוח PRD, סקירת Figma, מתודולוגיית בדיקות |
| 01 | `01_Test_Plan_Template.md` | תוכנית בדיקות — Scope, סוגי בדיקות, משאבים, סיכונים, Entry/Exit Criteria |
| 02 | `02_Test_Cases_Template.md` | תבנית Test Cases — 20 מקרי בדיקה מפורטים לדוגמה |
| 03 | `03_Test_Scenarios_Bank.md` | בנק 57 תרחישי בדיקה מאורגנים לפי מודול |
| 04 | `04_Bug_Report_Template.md` | תבנית דיווח באגים — פורמט מקצועי + 10 דוגמאות |
| 05 | `05_Bug_Taxonomy.md` | סיווג באגים — UI, פונקציונלי, ביצועים, אבטחה, Accessibility |
| 06 | `06_Jira_Bug_Workflow.md` | מחזור חיי באג ב-Jira — סטטוסים, שדות, תקשורת |
| 07 | `07_Test_Execution_Report_Template.md` | דוח הרצת בדיקות — מדדים, Go/No-Go Decision |
| 08 | `08_Sprint_QA_Summary_Template.md` | סיכום QA לספרינט — סטוריות, רגרסיה, אוטומציה |
| 09 | `09_Release_Checklist.md` | Checklist לפני שחרור גרסה — Smoke, Regression, אבטחה, Accessibility |
| 10 | `10_QA_Metrics_Dashboard.md` | מדדי QA ו-KPIs — Defect Density, Coverage, Escaped Defects |
| 11 | `11_Automation_Strategy.md` | אסטרטגיית אוטומציה — מתי לאוטמט, בחירת כלים, CI/CD |
| 12 | `12_Playwright_README.md` | README ל-Playwright — התקנה, קונפיגורציה, דוגמאות קוד |
| 13 | `13_Test_Automation_Report_Guide.md` | מדריך דוחות אוטומציה — Allure, Playwright HTML, CI/CD |
| 14 | `14_Page_Object_Model_Guide.md` | מדריך POM — ארכיטקטורה, דוגמאות TypeScript מלאות |
| 15 | `15_PRD_Review_Checklist.md` | Checklist לסקירת PRD — 30+ שאלות, זיהוי Edge Cases |
| 16 | `16_Figma_Design_QA_Checklist.md` | Checklist לסקירת עיצוב Figma — 40+ נקודות בדיקה |
| 17 | `17_User_Flow_Test_Mapping.md` | מיפוי User Flows ל-Test Cases — Happy/Error/Edge paths |

## איך להשתמש בערכה

1. **תחילת פרויקט** — התחל עם `00_QA_Kickoff_Guide.md` ו-`15_PRD_Review_Checklist.md`
2. **תכנון בדיקות** — השתמש ב-`01_Test_Plan_Template.md` ו-`03_Test_Scenarios_Bank.md`
3. **כתיבת טסטים** — השתמש ב-`02_Test_Cases_Template.md` ו-`17_User_Flow_Test_Mapping.md`
4. **סקירת עיצוב** — השתמש ב-`16_Figma_Design_QA_Checklist.md`
5. **דיווח באגים** — השתמש ב-`04_Bug_Report_Template.md` ו-`05_Bug_Taxonomy.md`
6. **סיכום ספרינט** — השתמש ב-`07_Test_Execution_Report_Template.md` ו-`08_Sprint_QA_Summary_Template.md`
7. **לפני שחרור** — השתמש ב-`09_Release_Checklist.md`
8. **אוטומציה** — השתמש ב-`11_Automation_Strategy.md`, `12_Playwright_README.md`, `14_Page_Object_Model_Guide.md`

## כלים מומלצים

| קטגוריה | כלי |
|---------|-----|
| Test Management | TestRail, Zephyr (Jira), QTest |
| Bug Tracking | Jira, Linear, GitHub Issues |
| Automation | Playwright, Cypress, Selenium |
| Reporting | Allure, Playwright HTML Report |
| Performance | Lighthouse, k6, WebPageTest |
| Accessibility | axe DevTools, WAVE, Lighthouse |
| API Testing | Postman, Insomnia, Playwright API |

## גרסה

- **v1.0** — יולי 2026 — גרסה ראשונית

---

נוצר על ידי Solene — Superagent AI
