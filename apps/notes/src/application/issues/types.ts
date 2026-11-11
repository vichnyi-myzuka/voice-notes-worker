import type { IssueLedger, IssueTracker } from "../../domain/issues";

export type IssuePorts = { issues: IssueTracker; issueLedger: IssueLedger };

// issueRepos — куди віднести нові задачі (ключ задачі → репозиторій; "" — це не робота над проєктом),
// issuesApplied — результат виконання. Кроки зберігаються в стані обробки, як і для задач Todoist.
export type IssueState = { issueRepos?: Record<string, string>; issuesApplied?: boolean };
