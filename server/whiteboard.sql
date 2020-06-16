/* user permissions */
CREATE USER `whiteboard`@`localhost` IDENTIFIED VIA mysql_native_password OR unix_socket;
GRANT SELECT ON `whiteboard`.* TO `whiteboard`@`localhost`;
GRANT INSERT ON `whiteboard`.`boards` TO `whiteboard`@`localhost`;
GRANT INSERT, DELETE ON `whiteboard`.`contents` TO `whiteboard`@`localhost`;

/* database and table creation */
CREATE DATABASE `whiteboard`;

USE `whiteboard`;

CREATE TABLE `boards` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `identifier` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `creation` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `boards_identifier_uindex` (`identifier`)
) ENGINE=InnoDB AUTO_INCREMENT=25 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `contents` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `board_id` int(11) NOT NULL,
  `type_id` int(11) NOT NULL,
  `created` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `content` mediumtext COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bounds_lower_x` int(11) NOT NULL,
  `bounds_upper_x` int(11) NOT NULL,
  `bounds_lower_y` int(11) NOT NULL,
  `bounds_upper_y` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `contents_types_id_fk` (`type_id`),
  KEY `contents_boards_id_fk` (`board_id`),
  CONSTRAINT `contents_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `contents_types_id_fk` FOREIGN KEY (`type_id`) REFERENCES `types` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1113 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` tinytext COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `types` VALUES (1,'path'),(2,'smooth');

/* cleanup event */
/* this requires you enable the event scheduler */
SET GLOBAL event_scheduler=ON;

CREATE EVENT whiteboard_cull_empty ON SCHEDULE EVERY 8 HOUR DO
  DELETE FROM boards WHERE
    (SELECT COUNT(*) FROM contents WHERE board_id=boards.id) = 0
	AND TIMESTAMPDIFF(HOUR, creation, current_timestamp()) > 24;
