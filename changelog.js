#!/usr/bin/env node

'use strict';

var child = require('child_process');
var fs = require('fs');
var util = require('util');
var Promise = require('bluebird');

var GIT_LOG_CMD = 'git log --grep="%s" -E --format=%s %s..HEAD';
var GIT_TAG_CMD = 'git describe --tags --abbrev=0';

var HEADER_TPL = '# %s (%s)\n\n';
var LINK_ISSUE = '[#%s](https://bitbucket.org/rabbitsystems/favodine/issues/%s)';
var LINK_COMMIT = '[%s](https://bitbucket.org/rabbitsystems/favodine/commits/%s)';

var EMPTY_COMPONENT = '$$';

var warn = function() {
  console.log('WARNING:', util.format.apply(null, arguments));
};

var parseRawCommit = function(raw) {
  if (!raw) return null;

  var lines = raw.split('\n');
  var msg = {}, match;

  msg.hash = lines.shift();
  msg.subject = lines.shift();
  msg.closes = [];
  msg.breaks = [];

  lines.forEach(function(line) {
    match = line.match(/(?:Closes|Fixes)\s#(\d+)/);
    if (match) msg.closes.push(parseInt(match[1]));
  });

  match = raw.match(/BREAKING CHANGE:([\s\S]*)/);
  if (match) {
    msg.breaking = match[1];
  }

  msg.body = lines.join('\n');
  match = msg.subject.match(/^(.*)\((.*)\)\:\s(.*)$/);

  if (!match || !match[1] || !match[3]) {
    warn('Incorrect message: %s %s', msg.hash, msg.subject);
    return null;
  }

  msg.type = match[1];
  msg.component = match[2];
  msg.subject = match[3];

  return msg;
};

var linkToIssue = function(issue) {
  return util.format(LINK_ISSUE, issue, issue);
};

var linkToCommit = function(hash) {
  return util.format(LINK_COMMIT, hash.substr(0, 8), hash);
};

var currentDate = function() {
  var now = new Date();
  var pad = function(i) {
    return ('0' + i).substr(-2);
  };

  return util.format('%d-%s-%s', now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()));
};

var printSection = function(stream, title, section, printCommitLinks) {
  printCommitLinks = printCommitLinks === undefined ? true : printCommitLinks;
  var components = Object.getOwnPropertyNames(section).sort();

  if (!components.length) return;

  stream.write(util.format('\n## %s\n\n', title));

  components.forEach(function(name) {
    var prefix = '-';
    var nested = section[name].length > 1;

    if (name !== EMPTY_COMPONENT) {
      if (nested) {
        stream.write(util.format('- **%s:**\n', name));
        prefix = '    -';
      } else {
        prefix = util.format('- **%s:**', name);
      }
    }

    section[name].forEach(function(commit) {
      if (printCommitLinks) {
        var format = nested ? '%s %s\n    (%s' : '%s %s\n  (%s';
        stream.write(util.format(format, prefix, commit.subject, linkToCommit(commit.hash)));
        if (commit.closes.length) {
          var lfPrefix = nested ? ',\n     ' : ',\n   ';
          stream.write(lfPrefix + commit.closes.map(linkToIssue).join(', '));
        }
        stream.write(')\n');
      } else {
        stream.write(util.format('%s %s\n', prefix, commit.subject));
      }
    });
  });

  stream.write('\n');
};

var readGitLog = function(grep, from) {
  var deferred = Promise.pending();

  // TODO(frikki): if it's slow, use spawn and stream it instead
  child.exec(util.format(GIT_LOG_CMD, grep, '%H%n%s%n%b%n==END==', from), function(code, stdout, stderr) {
    var commits = [];

    stdout.split('\n==END==\n').forEach(function(rawCommit) {
      var commit = parseRawCommit(rawCommit);
      if (commit) commits.push(commit);
    });

    deferred.fulfill(commits);
  });

  return deferred.promise;
};

var writeChangelog = function(stream, commits, version) {
  var sections = {
    fix: {},
    feat: {},
    perf: {},
    breaks: {}
  };

  //sections.breaks[EMPTY_COMPONENT] = [];

  commits.forEach(function(commit) {
    var section = sections[commit.type];
    var component = commit.component || EMPTY_COMPONENT;

    if (section) {
      section[component] = section[component] || [];
      section[component].push(commit);
    }

    if (commit.breaking) {
      sections.breaks[component] = sections.breaks[component] || [];
      sections.breaks[component].push({
        subject: util.format("due to %s,\n %s", linkToCommit(commit.hash), commit.breaking),
        hash: commit.hash,
        closes: []
      });
    }
  });

  stream.write(util.format(HEADER_TPL, version, currentDate()));
  printSection(stream, 'Bug Fixes', sections.fix);
  printSection(stream, 'Features', sections.feat);
  printSection(stream, 'Performance Improvements', sections.perf);
  printSection(stream, 'Breaking Changes', sections.breaks, false);
};

var getPreviousTag = function() {
  var deferred = Promise.pending();
  child.exec(GIT_TAG_CMD, function(code, stdout, stderr) {
    if (code) deferred.reject('Cannot get the previous tag.');
    else deferred.fulfill(stdout.replace('\n', ''));
  });
  return deferred.promise;
};

var generate = function(version, file) {

  getPreviousTag().then(function(tag) {
    console.log('Reading git log since', tag);
    readGitLog('^fix|^feat|^perf|BREAKING', tag).then(function(commits) {
      console.log('Parsed', commits.length, 'commits');
      console.log('Generating changelog to', file || 'stdout', '(', version, ')');
      writeChangelog(file ? fs.createWriteStream(file) : process.stdout, commits, version);
    });
  });
};

// publish for testing
exports.parseRawCommit = parseRawCommit;
exports.printSection = printSection;

// hacky start if not run by jasmine :-D
if (process.argv.join('').indexOf('jasmine-node') === -1) {
  generate(process.argv[2], process.argv[3]);
}
