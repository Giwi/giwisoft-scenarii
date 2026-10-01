import { Component, ChangeDetectionStrategy } from '@angular/core';
import { NgFor } from '@angular/common';

interface DocField {
  name: string;
  type: string;
  desc: string;
}

// Rendered from the component: the literal mustaches would be parsed as an
// interpolation by the Angular template compiler.
const MUSTACHES = '{{' + 'variable' + '}}';

// Scenario authoring reference. Static, no data fetching.
@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [NgFor],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './docs.html',
  styleUrl: './docs.css',
})
export class DocsComponent {
  readonly mustaches = MUSTACHES;

  readonly sections = [
    { id: 'file', label: 'The file' },
    { id: 'header', label: 'Header fields' },
    { id: 'steps', label: 'Steps' },
    { id: 'http', label: 'HTTP actions' },
    { id: 'browser', label: 'Browser actions' },
    { id: 'expect', label: 'Expectations' },
    { id: 'variables', label: 'Variables' },
    { id: 'include', label: 'Sharing steps' },
    { id: 'conditions', label: 'Conditions' },
  ];

  readonly headerFields: DocField[] = [
    { name: 'name', type: 'string', desc: 'Required. Identifies the scenario in the dashboard, history, and metrics.' },
    { name: 'steps', type: 'array', desc: 'Required. The ordered list of steps to execute.' },
    { name: 'description', type: 'string', desc: 'Free text shown under the name.' },
    { name: 'schedule', type: 'string', desc: 'Cron expression. Without it the scenario only runs on demand.' },
    { name: 'base_url', type: 'string', desc: 'Prefix applied to every relative url in the steps.' },
    { name: 'tags', type: 'string[]', desc: 'Drives the dashboard filters.' },
    { name: 'group', type: 'string', desc: 'Groups related scenarios together in the dashboard.' },
    { name: 'depends_on', type: 'string', desc: 'Name of a scenario that runs first.' },
    { name: 'timeout', type: 'number', desc: 'Scenario timeout in milliseconds, used when a step has none.' },
    { name: 'headless', type: 'boolean', desc: 'Run the browser headless. Defaults to true.' },
    { name: 'ignoreHTTPSErrors', type: 'boolean', desc: 'Accept self-signed certificates for browser steps.' },
    {
      name: 'time_windows',
      type: 'array',
      desc: 'Windows the scheduler may run in: start, end, optional timezone (HH:mm).',
    },
    {
      name: 'alert',
      type: 'map',
      desc: 'consecutive_failures: how many runs in a row trigger the alert state.',
    },
  ];

  readonly stepFields: DocField[] = [
    { name: 'name', type: 'string', desc: 'Label of the step, shown in the live ticker and in the run history.' },
    { name: 'action', type: 'string', desc: 'Required. One of the HTTP or browser actions listed below.' },
    { name: 'url', type: 'string', desc: 'Target. Relative urls are resolved against base_url.' },
    { name: 'headers', type: 'map', desc: 'Request headers (HTTP steps).' },
    { name: 'body', type: 'any', desc: 'Request body sent as JSON (HTTP steps).' },
    { name: 'selector', type: 'string', desc: 'CSS selector targeted by the action (browser steps).' },
    { name: 'value', type: 'string', desc: 'Value to type, select, or fill (browser steps).' },
    { name: 'script', type: 'string', desc: 'JavaScript evaluated in the page (browser.evaluate).' },
    { name: 'timeout', type: 'number', desc: 'Milliseconds before this step is aborted.' },
    { name: 'expect', type: 'map', desc: 'Assertions checked after the step runs.' },
    { name: 'variables', type: 'map', desc: 'Values extracted from the response for later steps.' },
    { name: 'condition', type: 'map', desc: 'Skip the step unless a previous step matched (see Conditions).' },
    { name: 'include', type: 'string', desc: 'Name of another scenario file whose steps are inlined here.' },
  ];

  readonly httpActions = [
    { action: 'http.get', desc: 'GET request.' },
    { action: 'http.post', desc: 'POST request.' },
    { action: 'http.put', desc: 'PUT request.' },
    { action: 'http.patch', desc: 'PATCH request.' },
    { action: 'http.delete', desc: 'DELETE request.' },
  ];

  readonly browserActions = [
    { action: 'browser.navigate', desc: 'Open a page.' },
    { action: 'browser.click', desc: 'Click a selector.' },
    { action: 'browser.fill', desc: 'Set an input value in one go.' },
    { action: 'browser.type', desc: 'Type text key by key.' },
    { action: 'browser.select', desc: 'Pick an option in a select element.' },
    { action: 'browser.check', desc: 'Tick a checkbox or radio.' },
    { action: 'browser.uncheck', desc: 'Clear a checkbox or radio.' },
    { action: 'browser.evaluate', desc: 'Run JavaScript in the page.' },
    { action: 'browser.scroll', desc: 'Scroll to a selector or position.' },
    { action: 'browser.wait_for', desc: 'Wait for a selector to appear.' },
    { action: 'browser.screenshot', desc: 'Capture a screenshot.' },
    { action: 'browser.screenshot_compare', desc: 'Compare against a stored baseline.' },
  ];

  readonly httpExpects: DocField[] = [
    { name: 'status', type: 'number', desc: 'Exact status code.' },
    { name: 'status_in', type: 'number[]', desc: 'Any of these status codes is a pass.' },
    { name: 'body_contains', type: 'string', desc: 'Substring present in the response body.' },
    { name: 'body_matches', type: 'string', desc: 'Regular expression matched against the body.' },
    { name: 'header_contains', type: 'string', desc: 'Substring present in the response headers.' },
    { name: 'header_matches', type: 'string', desc: 'Regular expression matched against the headers.' },
    { name: 'json_path', type: 'string', desc: 'Dot path into the JSON body, e.g. $.userId or $.data.items[0].id.' },
    { name: 'json_value', type: 'any', desc: 'Value json_path must equal. Compared together with json_path.' },
    { name: 'response_time_under', type: 'number', desc: 'Fail when the response is slower than this many ms.' },
    { name: 'body_schema', type: 'object', desc: 'Expected JSON shape.' },
  ];

  readonly browserExpects: DocField[] = [
    { name: 'has_text', type: 'string', desc: 'Text that must be visible on the page.' },
    { name: 'not_has_text', type: 'string', desc: 'Text that must be absent.' },
    { name: 'url_contains', type: 'string', desc: 'Substring the current URL must contain.' },
    { name: 'selector_count', type: 'number', desc: 'Exact number of matches for a selector.' },
  ];

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}