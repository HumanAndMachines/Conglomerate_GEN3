#!/usr/bin/perl

use strict;
use warnings;
use utf8;
use Errno qw(EEXIST ENOENT);
use Fcntl qw(:DEFAULT :mode);
use JSON::PP qw(decode_json encode_json);
use Time::HiRes qw(sleep time);

my $claimed = 0;
my $config;

sub finish {
  my ($payload, $exit_code) = @_;
  print encode_json($payload);
  exit($exit_code);
}

sub failure {
  my ($code, $message, $exit_code, $detail) = @_;
  finish(
    {
      ok => JSON::PP::false,
      outcome => "failed",
      code => $code,
      message => $message,
      detail => defined($detail) ? substr($detail, 0, 160) : undef,
    },
    $exit_code,
  );
}

sub valid_segment {
  my ($segment) = @_;
  return 0 unless defined($segment) && !ref($segment);
  return 0 if $segment eq "" || $segment eq "." || $segment eq "..";
  return $segment !~ m{[\\/\0\r\n]};
}

sub pause_for_test {
  my ($phase) = @_;
  my $hook = $config->{testHook};
  return unless ref($hook) eq "HASH" && ($hook->{phase} // "") eq $phase;
  my $ready = $hook->{readyPath};
  my $proceed = $hook->{proceedPath};
  die "invalid_test_hook\n"
    unless defined($ready) && defined($proceed) && $ready ne "" && $proceed ne "";
  sysopen(my $signal, $ready, O_WRONLY | O_CREAT | O_EXCL, 0600)
    or die "test_hook_ready_failed\n";
  print {$signal} "ready\n";
  close($signal);
  my $deadline = time() + 15;
  until (-e $proceed) {
    die "test_hook_timeout\n" if time() >= $deadline;
    sleep(0.02);
  }
}

sub run_git {
  my (@args) = @_;
  my $pid = open(my $stdout, "-|");
  die "git_fork_failed\n" unless defined($pid);
  if ($pid == 0) {
    exec {$config->{gitExecutable}} $config->{gitExecutable}, @args;
    exit(127);
  }
  local $/;
  my $output = <$stdout>;
  $output = "" unless defined($output);
  close($stdout);
  my $status = $?;
  return {
    ok => $status == 0,
    output => $output =~ s/\s+\z//r,
  };
}

eval {
  local $/;
  my $input = <STDIN>;
  $config = decode_json($input // "");
  die "invalid_config\n" unless ref($config) eq "HASH";

  my $organization_root = $config->{organizationRoot};
  my $segments = $config->{slotSegments};
  my $remote = $config->{remote};
  my $branch = $config->{branch};
  my $git = $config->{gitExecutable};
  die "invalid_config\n"
    unless defined($organization_root)
    && !ref($organization_root)
    && $organization_root ne ""
    && ref($segments) eq "ARRAY"
    && @{$segments} >= 1
    && !grep { !valid_segment($_) } @{$segments}
    && defined($remote)
    && !ref($remote)
    && $remote ne ""
    && $remote !~ /\0/
    && defined($branch)
    && !ref($branch)
    && $branch ne ""
    && $branch !~ /[\0\r\n]/
    && defined($git)
    && !ref($git)
    && $git ne "";

  sysopen(
    my $organization_handle,
    $organization_root,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
  ) or die "organization_anchor_failed\n";
  my @organization_stat = stat($organization_handle);
  die "organization_anchor_not_directory\n"
    unless @organization_stat && S_ISDIR($organization_stat[2]);
  chdir($organization_handle) or die "organization_anchor_chdir_failed\n";

  my @handles = ($organization_handle);
  for my $index (0 .. $#{$segments} - 1) {
    my $segment = $segments->[$index];
    my $next_handle;
    if (!sysopen(
      $next_handle,
      $segment,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
    )) {
      die "parent_anchor_failed\n" unless $! == ENOENT;
      if (!mkdir($segment, 0777)) {
        die "parent_claim_failed\n" unless $! == EEXIST;
      }
      sysopen(
        $next_handle,
        $segment,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
      ) or die "parent_anchor_failed\n";
    }
    my @next_stat = stat($next_handle);
    die "parent_anchor_not_directory\n"
      unless @next_stat && S_ISDIR($next_stat[2]);
    chdir($next_handle) or die "parent_anchor_chdir_failed\n";
    push(@handles, $next_handle);
  }

  pause_for_test("before_claim");

  my $target_name = $segments->[-1];
  if (!mkdir($target_name, 0777)) {
    if ($! == EEXIST) {
      finish(
        {
          ok => JSON::PP::false,
          outcome => "target_exists",
          code => "materialization_target_appeared",
          message => "Cílový checkout mezitím vytvořil jiný proces; Launchpad ho ponechal beze změny.",
        },
        20,
      );
    }
    die "target_claim_failed\n";
  }
  $claimed = 1;

  sysopen(
    my $target_handle,
    $target_name,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
  ) or die "target_anchor_failed\n";
  my @target_stat = stat($target_handle);
  die "target_anchor_not_directory\n"
    unless @target_stat && S_ISDIR($target_stat[2]);
  chdir($target_handle) or die "target_anchor_chdir_failed\n";
  push(@handles, $target_handle);

  opendir(my $entries, ".") or die "target_read_failed\n";
  my @unexpected = grep { $_ ne "." && $_ ne ".." } readdir($entries);
  closedir($entries);
  die "target_not_empty\n" if @unexpected;

  pause_for_test("after_target_anchor");

  my @commands = (
    ["init", "--initial-branch=$branch", "."],
    ["remote", "add", "origin", $remote],
    [
      "config",
      "remote.origin.fetch",
      "+refs/heads/$branch:refs/remotes/origin/$branch",
    ],
    ["fetch", "--no-tags", "origin"],
    ["checkout", "--force", "-B", $branch, "--track", "origin/$branch"],
  );
  for my $command (@commands) {
    my $result = run_git(@{$command});
    die "git_write_failed\n" unless $result->{ok};
  }

  my $root = run_git("rev-parse", "--show-toplevel");
  my $current_branch = run_git("branch", "--show-current");
  my $origin = run_git("remote", "get-url", "origin");
  my $head = run_git("rev-parse", "--verify", "HEAD^{commit}");
  my $status = run_git("status", "--porcelain=v1");
  die "git_verification_failed\n"
    unless $root->{ok}
    && $root->{output} ne ""
    && $current_branch->{ok}
    && $current_branch->{output} eq $branch
    && $origin->{ok}
    && $origin->{output} eq $remote
    && $head->{ok}
    && $head->{output} =~ /\A[0-9a-f]{40}\z/
    && $status->{ok}
    && $status->{output} eq "";

  finish(
    {
      ok => JSON::PP::true,
      outcome => "materialized",
      code => undef,
      message => "Nový manifestovaný modul byl bezpečně naklonovaný přes ukotvený directory handle.",
      branch => $branch,
      head => $head->{output},
      remote => $remote,
      anchor => {
        device => "$target_stat[0]",
        inode => "$target_stat[1]",
      },
    },
    0,
  );
};

my $error = $@ || "unknown_helper_failure\n";
if ($claimed) {
  failure(
    "materialization_incomplete",
    "Ukotvený Git checkout po claimu selhal; částečný adresář zůstal beze smazání pro ruční kontrolu.",
    30,
    $error,
  );
}
failure(
  "materialization_path_forbidden",
  "No-follow directory anchor nešlo bezpečně získat; target nebyl vytvořen.",
  31,
  $error,
);
